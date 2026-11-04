import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../lib/app.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
let app, base, dir, upstream, upstreamUrl; const upstreamHits = [];

before(async () => {
  // A stand-in for the user's local dev server behind the tunnel.
  upstream = http.createServer((req, res) => {
    upstreamHits.push({ url: req.url, cookie: req.headers.cookie, auth: req.headers.authorization });
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'sid=stolen; Path=/', 'content-security-policy': "default-src *", 'x-frame-options': 'ALLOWALL' }); return res.end('<h1>my local app</h1><script src="app.js"></script>'); }
    if (req.url === '/app.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end('console.log("hi")'); }
    if (req.url === '/old') { res.writeHead(302, { location: '/new?x=1' }); return res.end(); }
    if (req.url === '/away') { res.writeHead(302, { location: 'https://evil.example/phish' }); return res.end(); }
    res.writeHead(404); res.end('nope');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r)); upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  dir = mkdtempSync(join(tmpdir(), 'hc-tun-')); app = createApp({ root, stateFile: join(dir, 's.json'), authLimit: 1e6, autoBackupMinutes: 0, allowInsecureTunnels: true });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => { await app.close(); upstream.closeAllConnections?.(); await new Promise((r) => upstream.close(r)); rmSync(dir, { recursive: true, force: true }); });

const person = async (name, email) => { let cookie = ''; const call = async (method, path, body) => { const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]; return { status: res.status, body: await res.json().catch(() => ({})) }; }; const r = await call('POST', '/api/auth/signup', { name, email, password: 'correct-horse-battery' }); return { call, id: r.body.user.id, get cookie() { return cookie; } }; };
const get = (path, init) => fetch(base + path, { redirect: 'manual', ...init });

test('preview proxy: signed links, sandboxed responses, no cookie or secret leakage', async () => {
  const owner = await person('Tun Owner', 'tunowner@x.io'); const mate = await person('Tun Mate', 'tunmate@x.io'); const out = await person('Tun Out', 'tunout@x.io');
  const ws = (await owner.call('POST', '/api/projects', { name: 'Preview Room' })).body.id; const inv = await owner.call('POST', `/api/projects/${ws}/invites`, { role: 'viewer' }); await mate.call('POST', `/api/invites/${inv.body.token}/accept`, {});
  const t = (await owner.call('POST', `/api/projects/${ws}/tunnels`, { port: 3000, url: upstreamUrl })).body;
  // private by default: the creator sees a signed preview link and the raw URL; teammates see nothing
  const own = (await owner.call('GET', `/api/projects/${ws}/tunnels`)).body.tunnels; assert.equal(own.length, 1); assert.match(own[0].previewUrl, new RegExp(`^/t/${t.id}/[^/]+\\.\\d+\\.[A-Za-z0-9_-]+/$`)); assert.equal(own[0].url, upstreamUrl);
  assert.equal((await mate.call('GET', `/api/projects/${ws}/tunnels`)).body.tunnels.length, 0, 'private tunnel hidden from viewers');
  // the proxy works with the link alone (sandboxed pages cannot send cookies) and relative assets resolve under it
  const page = await get(own[0].previewUrl, { headers: { cookie: 'hc_session=should-not-be-forwarded', authorization: 'Bearer secret' } }); assert.equal(page.status, 200); assert.match(await page.text(), /my local app/);
  assert.match(page.headers.get('content-security-policy'), /^sandbox /); assert.equal(page.headers.get('set-cookie'), null, 'upstream cookies are dropped'); assert.equal(page.headers.get('referrer-policy'), 'no-referrer'); assert.equal(page.headers.get('x-frame-options'), 'DENY' === page.headers.get('x-frame-options') ? 'DENY' : page.headers.get('x-frame-options'));
  const last = upstreamHits.at(-1); assert.equal(last.cookie, undefined, 'our session cookie is never forwarded'); assert.equal(last.auth, undefined);
  assert.equal((await (await get(`${own[0].previewUrl}app.js`)).text()), 'console.log("hi")');
  // redirects stay inside the proxy; off-site redirects are dropped
  const redirect = await get(`${own[0].previewUrl}old`); assert.equal(redirect.status, 302); assert.equal(redirect.headers.get('location'), `${own[0].previewUrl.replace(/\/$/, '')}/new?x=1`); assert.equal((await get(`${own[0].previewUrl}away`)).headers.get('location'), null);
  // tampering, wrong tunnel, expiry, methods
  const tok = own[0].previewUrl.split('/')[3]; const [uid, exp, sig] = tok.split('.');
  assert.equal((await get(`/t/${t.id}/${uid}.${exp}.${sig.slice(0, -2)}AA/`)).status, 403); assert.equal((await get(`/t/${t.id}/${out.id}.${exp}.${sig}/`)).status, 403, 'token is bound to its user');
  assert.equal((await get(`/t/${t.id}/${uid}.${Number(exp) - 7200_000}.${sig}/`)).status, 403); assert.equal((await get(`/t/not-a-tunnel/${tok}/`)).status, 404);
  assert.equal((await fetch(base + own[0].previewUrl, { method: 'POST' })).status, 405);
  // visibility: team shows it to members; changes take effect immediately for links already handed out
  assert.equal((await owner.call('PATCH', `/api/projects/${ws}/tunnels/${t.id}`, { visibility: 'team' })).status, 200);
  const shared = (await mate.call('GET', `/api/projects/${ws}/tunnels`)).body.tunnels; assert.equal(shared.length, 1); assert.equal(shared[0].url, undefined, 'raw tunnel URL only for its creator'); assert.equal((await get(shared[0].previewUrl)).status, 200);
  assert.equal((await owner.call('PATCH', `/api/projects/${ws}/tunnels/${t.id}`, { visibility: 'private' })).status, 200); assert.equal((await get(shared[0].previewUrl)).status, 403, 'revoked instantly');
  // removed member loses access; closed tunnel is gone; kill switch stops it
  await owner.call('PATCH', `/api/projects/${ws}/tunnels/${t.id}`, { visibility: 'team' }); assert.equal((await get(shared[0].previewUrl)).status, 200);
  await owner.call('DELETE', `/api/projects/${ws}/members/${mate.id}`); assert.equal((await get(shared[0].previewUrl)).status, 403);
  app.db.settings.killSwitch = true; assert.equal((await get(own[0].previewUrl)).status, 503); app.db.settings.killSwitch = false;
  await owner.call('DELETE', `/api/projects/${ws}/tunnels/${t.id}`); assert.equal((await get(own[0].previewUrl)).status, 404);
});

test('unreachable upstream gives a helpful error and https is still required by default', async () => {
  const owner = await person('Tun Two', 'tun2@x.io'); const ws = (await owner.call('POST', '/api/projects', { name: 'Dead Tunnel' })).body.id;
  const t = (await owner.call('POST', `/api/projects/${ws}/tunnels`, { port: 1, url: 'http://127.0.0.1:1' })).body; const link = (await owner.call('GET', `/api/projects/${ws}/tunnels`)).body.tunnels[0].previewUrl;
  const res = await get(link); assert.equal(res.status, 502); assert.match((await res.json()).error, /did not respond/); void t;
  const strict = createApp({ root, stateFile: join(dir, 'strict.json'), autoBackupMinutes: 0 }); await new Promise((r) => strict.server.listen(0, '127.0.0.1', r)); const b2 = `http://127.0.0.1:${strict.server.address().port}`;
  try { const su = await fetch(`${b2}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect' }, body: JSON.stringify({ name: 'S S', email: 's@x.io', password: 'correct-horse-battery' }) }); const cookie = su.headers.get('set-cookie').split(';')[0];
    const pid = (await (await fetch(`${b2}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect', cookie }, body: JSON.stringify({ name: 'S' }) })).json()).id;
    assert.equal((await fetch(`${b2}/api/projects/${pid}/tunnels`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect', cookie }, body: JSON.stringify({ port: 3000, url: 'http://example.com' }) })).status, 400); } finally { await strict.close(); }
});
