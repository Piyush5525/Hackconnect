import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createApp } from '../lib/app.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
let app, base, dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hc-test-'));
  app = createApp({ root, stateFile: join(dir, 'state.json'), authLimit: 1000 });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

// Minimal cookie-jar client
const client = () => {
  let cookie = '';
  const call = async (method, path, body, { csrf = true } = {}) => {
    const headers = { 'content-type': 'application/json' }; if (cookie) headers.cookie = cookie; if (csrf) headers['x-requested-with'] = 'hackconnect';
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => ({})), res };
  };
  return { call, get cookie() { return cookie; } };
};
const signup = async (name, email) => { const c = client(); const r = await c.call('POST', '/api/auth/signup', { name, email, password: 'correct-horse-battery' }); assert.equal(r.status, 201); return c; };

test('static server only serves allowlisted files', async () => {
  for (const path of ['/server.mjs', '/.env', '/.hackconnect/state.json', '/lib/auth.mjs', '/package.json', '/..%2fserver.mjs']) {
    const res = await fetch(base + path); assert.equal(res.status, 404, path);
  }
  for (const path of ['/vendor/../server.mjs', '/vendor/%2e%2e/server.mjs', '/vendor/collab-client.js.map', '/vendor/monaco/../../.env', '/vendor/%2e%2e%2f.env']) assert.equal((await fetch(base + path)).status, 404, path);
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/app.js')).status, 200);
});

test('unauthenticated API access is rejected', async () => {
  const c = client();
  assert.equal((await c.call('GET', '/api/bootstrap')).status, 401);
  assert.equal((await c.call('GET', '/api/projects/pulseboard')).status, 401);
  assert.equal((await c.call('GET', '/api/auth/me')).status, 401);
});

test('signup validation, duplicate email, CSRF header, cookie flags', async () => {
  const c = client();
  assert.equal((await c.call('POST', '/api/auth/signup', { name: 'A', email: 'bad', password: 'correct-horse-battery' })).status, 400);
  assert.equal((await c.call('POST', '/api/auth/signup', { name: 'A', email: 'a@x.io', password: 'short' })).status, 400);
  assert.equal((await c.call('POST', '/api/auth/signup', { name: 'A', email: 'a@x.io', password: 'correct-horse-battery' }, { csrf: false })).status, 403);
  const ok = await c.call('POST', '/api/auth/signup', { name: 'Admin Ada', email: 'ada@x.io', password: 'correct-horse-battery' });
  assert.equal(ok.status, 201); assert.equal(ok.body.user.role, 'admin'); assert.equal(ok.body.user.passwordHash, undefined);
  const flags = ok.res.headers.get('set-cookie'); assert.match(flags, /HttpOnly/); assert.match(flags, /SameSite=Lax/);
  assert.equal((await client().call('POST', '/api/auth/signup', { name: 'Dup', email: 'ADA@x.io', password: 'correct-horse-battery' })).status, 409);
  assert.equal((await c.call('GET', '/api/auth/me')).body.user.email, 'ada@x.io');
});

test('login failure, logout invalidates session', async () => {
  const c = await signup('Bob Lee', 'bob@x.io');
  const bad = client(); assert.equal((await bad.call('POST', '/api/auth/login', { email: 'bob@x.io', password: 'wrong-password-123' })).status, 401);
  assert.equal((await bad.call('POST', '/api/auth/login', { email: 'nobody@x.io', password: 'wrong-password-123' })).status, 401);
  const good = client(); assert.equal((await good.call('POST', '/api/auth/login', { email: 'bob@x.io', password: 'correct-horse-battery' })).status, 200);
  const stale = good.cookie; await good.call('POST', '/api/auth/logout', {});
  const replay = await fetch(base + '/api/auth/me', { headers: { cookie: stale } }); assert.equal(replay.status, 401);
  assert.equal((await c.call('GET', '/api/auth/me')).status, 200);
});

test('workspace isolation, invites, roles, and revocation', async () => {
  const owner = await signup('Olive Owner', 'olive@x.io'); const guest = await signup('Gus Guest', 'gus@x.io'); const outsider = await signup('Ozzy Out', 'ozzy@x.io');
  const created = await owner.call('POST', '/api/projects', { name: 'Secret Sauce' }); assert.equal(created.status, 201); const id = created.body.id; assert.equal(created.body.role, 'owner');

  // outsider cannot see it, and existence is hidden (404 not 403)
  assert.equal((await outsider.call('GET', `/api/projects/${id}`)).status, 404);
  assert.equal((await outsider.call('PUT', `/api/projects/${id}/files`, { path: 'x.js', content: 'hack' })).status, 404);
  assert.ok(!(await outsider.call('GET', '/api/bootstrap')).body.projects.some((p) => p.id === id));

  // viewer invite: can read, cannot write
  const invite = await owner.call('POST', `/api/projects/${id}/invites`, { role: 'viewer' }); assert.equal(invite.status, 201);
  assert.equal((await outsider.call('POST', `/api/projects/${id}/invites`, { role: 'owner' })).status, 404);
  assert.equal((await guest.call('POST', `/api/invites/${invite.body.token}/accept`, {})).status, 200);
  assert.equal((await guest.call('GET', `/api/projects/${id}`)).body.project.role, 'viewer');
  assert.equal((await guest.call('PUT', `/api/projects/${id}/files`, { path: 'a.js', content: '1' })).status, 403);
  assert.equal((await guest.call('POST', `/api/projects/${id}/agent`, { prompt: 'hi' })).status, 403);
  assert.equal((await guest.call('POST', `/api/projects/${id}/invites`, { role: 'owner' })).status, 403);
  assert.equal((await guest.call('POST', `/api/projects/${id}/messages`, { text: 'hello' })).status, 201);
  assert.equal((await outsider.call('POST', '/api/invites/not-a-token/accept', {})).status, 404);

  // promote to editor -> can write; path traversal rejected
  assert.equal((await owner.call('PATCH', `/api/projects/${id}/members/${(await guest.call('GET', '/api/auth/me')).body.user.id}`, { role: 'editor' })).status, 200);
  assert.equal((await guest.call('PUT', `/api/projects/${id}/files`, { path: 'a.js', content: '1' })).status, 200);
  for (const bad of ['../x', '/etc/passwd', 'C:\\x', 'a/../../x']) assert.equal((await guest.call('PUT', `/api/projects/${id}/files`, { path: bad, content: '1' })).status, 400, bad);
  assert.equal((await guest.call('PATCH', `/api/projects/${id}/members/${(await guest.call('GET', '/api/auth/me')).body.user.id}`, { role: 'owner' })).status, 403);

  // sole owner cannot be demoted/removed
  const ownerId = (await owner.call('GET', '/api/auth/me')).body.user.id;
  assert.equal((await owner.call('PATCH', `/api/projects/${id}/members/${ownerId}`, { role: 'viewer' })).status, 409);
  assert.equal((await owner.call('DELETE', `/api/projects/${id}/members/${ownerId}`)).status, 409);

  // removal revokes access
  assert.equal((await owner.call('DELETE', `/api/projects/${id}/members/${(await guest.call('GET', '/api/auth/me')).body.user.id}`)).status, 200);
  assert.equal((await guest.call('GET', `/api/projects/${id}`)).status, 404);
});

test('team invites and team-owned workspaces', async () => {
  const lead = await signup('Tara Lead', 'tara@x.io'); const mate = await signup('Max Mate', 'max@x.io');
  const t = await lead.call('POST', '/api/teams', { name: 'Team Rocket' }); assert.equal(t.status, 201);
  const inv = await lead.call('POST', `/api/teams/${t.body.id}/invites`, {}); assert.equal(inv.status, 201);
  assert.equal((await mate.call('POST', `/api/teams/${t.body.id}/invites`, {})).status, 404);
  assert.equal((await mate.call('POST', `/api/invites/${inv.body.token}/accept`, {})).status, 200);
  assert.equal((await mate.call('POST', `/api/teams/${t.body.id}/invites`, {})).status, 403); // plain member cannot invite
  const ws = await lead.call('POST', '/api/projects', { name: 'Rocket Fuel', teamId: t.body.id }); assert.equal(ws.status, 201);
  assert.equal((await mate.call('GET', `/api/projects/${ws.body.id}`)).body.project.role, 'editor');
  assert.equal((await mate.call('POST', '/api/projects', { name: 'Hijack', teamId: t.body.id })).status, 403);
});

test('websocket requires a session and workspace access', async () => {
  const owner = await signup('Wendy WS', 'wendy@x.io'); const other = await signup('Walt WS', 'walt@x.io');
  const id = (await owner.call('POST', '/api/projects', { name: 'WS Room' })).body.id;
  const open = (cookie, projectId) => new Promise((resolve) => { const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?projectId=${projectId}`, { headers: cookie ? { cookie } : {} }); ws.on('message', (m) => { if (JSON.parse(m).type === 'connected') { resolve({ ok: true, ws }); } }); ws.on('close', (code) => resolve({ ok: false, code })); ws.on('error', () => {}); });
  assert.equal((await open('', id)).code, 4401);
  assert.equal((await open(other.cookie, id)).code, 4403);
  const good = await open(owner.cookie, id); assert.equal(good.ok, true); good.ws.close();
});

test('auth endpoints are rate limited', async () => {
  const limited = createApp({ root, stateFile: join(dir, 'limited.json'), authLimit: 3 });
  await new Promise((resolve) => limited.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${limited.server.address().port}/api/auth/login`; const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect' }, body: JSON.stringify({ email: 'n@x.io', password: 'wrong-password-123' }) })).status);
  await limited.close();
  assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
});
