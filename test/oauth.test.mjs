import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../lib/app.mjs';
import { encrypt, decrypt } from '../lib/crypto.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
let app, base, dir, mock, mockBase; const challenges = new Map(); const profiles = new Map(); const seenAuth = [];
const KEYS = ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'HACKCONNECT_OAUTH_GITHUB_AUTH_URL', 'HACKCONNECT_OAUTH_GITHUB_TOKEN_URL', 'HACKCONNECT_GITHUB_API_URL', 'HACKCONNECT_OAUTH_GOOGLE_AUTH_URL', 'HACKCONNECT_OAUTH_GOOGLE_TOKEN_URL', 'HACKCONNECT_OAUTH_GOOGLE_USERINFO_URL'];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hc-oauth-'));
  // A tiny fake GitHub/Google: token endpoint (checks PKCE + secret), profile endpoints, and a repo contents endpoint.
  mock = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c; const url = new URL(req.url, 'http://x'); const send = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (url.pathname === '/token') {
      const f = new URLSearchParams(body); const code = f.get('code'); const challenge = challenges.get(code.split(':')[0]);
      if (f.get('client_secret') !== 'shh' || !challenge || crypto.createHash('sha256').update(f.get('code_verifier')).digest('base64url') !== challenge) return send(400, { error: 'bad_verification_code' });
      return send(200, { access_token: `tok:${code}`, scope: code.endsWith(':repo') ? 'read:user,user:email,repo' : 'read:user,user:email' });
    }
    const token = String(req.headers.authorization || '').replace('Bearer ', ''); const code = token.replace('tok:', ''); const p = profiles.get(code.split(':')[0]);
    if (url.pathname === '/user') return p ? send(200, { id: p.id, login: p.login, name: p.name }) : send(401, {});
    if (url.pathname === '/user/emails') return send(200, p.emails);
    if (url.pathname === '/userinfo') return p ? send(200, { sub: p.id, email: p.email, email_verified: p.verified, name: p.name }) : send(401, {});
    if (url.pathname.startsWith('/repos/')) { seenAuth.push(req.headers.authorization); return send(url.searchParams.has('ref') ? 404 : 201, {}); }
    send(404, {});
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r)); mockBase = `http://127.0.0.1:${mock.address().port}`;
  Object.assign(process.env, { GITHUB_CLIENT_ID: 'gh-id', GITHUB_CLIENT_SECRET: 'shh', GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'shh', HACKCONNECT_OAUTH_GITHUB_AUTH_URL: `${mockBase}/authorize`, HACKCONNECT_OAUTH_GITHUB_TOKEN_URL: `${mockBase}/token`, HACKCONNECT_GITHUB_API_URL: mockBase, HACKCONNECT_OAUTH_GOOGLE_AUTH_URL: `${mockBase}/authorize`, HACKCONNECT_OAUTH_GOOGLE_TOKEN_URL: `${mockBase}/token`, HACKCONNECT_OAUTH_GOOGLE_USERINFO_URL: `${mockBase}/userinfo` });
  app = createApp({ root, stateFile: join(dir, 'state.json'), authLimit: 1000 }); await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => { await app.close(); mock.closeAllConnections?.(); await new Promise((r) => mock.close(r)); for (const k of KEYS) delete process.env[k]; rmSync(dir, { recursive: true, force: true }); });

const jar = () => { let cookie = ''; return { get cookie() { return cookie; }, take(res) { for (const c of res.headers.getSetCookie?.() || []) { const [pair] = c.split(';'); const [name, value] = pair.split('='); if (/Max-Age=0/.test(c)) cookie = cookie.split('; ').filter((x) => x && !x.startsWith(`${name}=`)).join('; '); else cookie = cookie.split('; ').filter((x) => x && !x.startsWith(`${name}=`)).concat(`${name}=${value}`).join('; '); } } }; };
const get = async (j, path) => { const res = await fetch(base + path, { redirect: 'manual', headers: j.cookie ? { cookie: j.cookie } : {} }); j.take(res); return res; };
const call = async (j, method, path, body) => { const res = await fetch(base + path, { method, redirect: 'manual', headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect', ...(j.cookie ? { cookie: j.cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); j.take(res); return { status: res.status, body: await res.json().catch(() => ({})) }; };

/** Drive start -> (fake provider consent) -> callback. `who` registers the profile the fake provider will return. */
async function oauthFlow(j, provider, who, { link = false, repo = false, tamperState = false } = {}) {
  const start = await get(j, `/api/auth/oauth/${provider}/start${link ? '?link=1' : ''}`); assert.equal(start.status, 302);
  const loc = new URL(start.headers.get('location')); if (loc.origin !== mockBase) return { start, loc };
  const state = loc.searchParams.get('state'); const code = `${state}${repo ? ':repo' : ''}`; challenges.set(state, loc.searchParams.get('code_challenge')); profiles.set(state, who);
  const cb = await get(j, `/api/auth/oauth/${provider}/callback?code=${encodeURIComponent(code)}&state=${tamperState ? 'wrong' : state}`);
  return { start, loc, cb };
}

test('providers are reported; unconfigured provider is refused politely', async () => {
  const j = jar(); assert.deepEqual((await (await get(j, '/api/auth/providers')).json()).providers, { github: true, google: true });
  const saved = process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_ID;
  try { assert.deepEqual((await (await get(j, '/api/auth/providers')).json()).providers, { github: true, google: false }); const r = await get(j, '/api/auth/oauth/google/start'); assert.match(r.headers.get('location'), /auth_error=.*not%20configured/); } finally { process.env.GOOGLE_CLIENT_ID = saved; }
  assert.match((await get(j, '/api/auth/oauth/nope/start')).headers.get('location'), /auth_error/);
});

test('start redirect carries PKCE + state and sets a binding cookie', async () => {
  const j = jar(); const start = await get(j, '/api/auth/oauth/github/start'); const loc = new URL(start.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, `${mockBase}/authorize`); assert.equal(loc.searchParams.get('client_id'), 'gh-id'); assert.equal(loc.searchParams.get('code_challenge_method'), 'S256'); assert.ok(loc.searchParams.get('state').length > 20);
  assert.match(loc.searchParams.get('redirect_uri'), /\/api\/auth\/oauth\/github\/callback$/); assert.equal(loc.searchParams.get('scope'), 'read:user user:email repo');
  assert.match(start.headers.getSetCookie().join(';'), /hc_oauth=.+HttpOnly/);
});

test('GitHub sign-up creates a verified account and signs in; a second login reuses it', async () => {
  const j = jar(); const who = { id: 'gh-1001', login: 'octo', name: 'Octo Cat', emails: [{ email: 'Octo@Example.com', primary: true, verified: true }] };
  const { cb } = await oauthFlow(j, 'github', who); assert.equal(cb.status, 302); assert.equal(cb.headers.get('location'), '/');
  const me = await call(j, 'GET', '/api/auth/me'); assert.equal(me.body.user.email, 'octo@example.com'); assert.equal(me.body.user.name, 'Octo Cat'); assert.equal(me.body.user.hasPassword, false);
  assert.equal(app.db.users.find((u) => u.email === 'octo@example.com').emailVerified, true);
  const j2 = jar(); await oauthFlow(j2, 'github', who); assert.equal(app.db.users.filter((u) => u.email === 'octo@example.com').length, 1);
  assert.equal((await call(j2, 'GET', '/api/auth/me')).body.user.id, me.body.user.id);
  // an OAuth-only account cannot be used through password login
  assert.equal((await call(jar(), 'POST', '/api/auth/login', { email: 'octo@example.com', password: 'anything-at-all-123' })).status, 401);
});

test('Google sign-in works and rejects unverified emails', async () => {
  const j = jar(); const { cb } = await oauthFlow(j, 'google', { id: 'g-7', email: 'gina@example.com', verified: true, name: 'Gina G' }); assert.equal(cb.headers.get('location'), '/'); assert.equal((await call(j, 'GET', '/api/auth/me')).body.user.name, 'Gina G');
  const bad = jar(); const r = await oauthFlow(bad, 'google', { id: 'g-8', email: 'fake@example.com', verified: false, name: 'Fake' }); assert.match(r.cb.headers.get('location'), /auth_error=.*verified/); assert.equal((await call(bad, 'GET', '/api/auth/me')).status, 401);
  const noMail = jar(); const r2 = await oauthFlow(noMail, 'github', { id: 'gh-nomail', login: 'ghost', name: 'Ghost', emails: [{ email: 'x@y.z', primary: true, verified: false }] }); assert.match(r2.cb.headers.get('location'), /auth_error/);
});

test('state tampering and replays are rejected', async () => {
  const j = jar(); const r = await oauthFlow(j, 'github', { id: 'gh-t', login: 't', name: 'T', emails: [{ email: 't@example.com', primary: true, verified: true }] }, { tamperState: true });
  assert.match(r.cb.headers.get('location'), /auth_error=Sign-in%20expired/); assert.equal((await call(j, 'GET', '/api/auth/me')).status, 401);
  assert.equal(app.db.users.some((u) => u.email === 't@example.com'), false);
  // replaying a used state fails
  const j2 = jar(); const start = await get(j2, '/api/auth/oauth/github/start'); const state = new URL(start.headers.get('location')).searchParams.get('state'); challenges.set(state, new URL(start.headers.get('location')).searchParams.get('code_challenge')); profiles.set(state, { id: 'gh-r', login: 'r', name: 'R', emails: [{ email: 'r@example.com', primary: true, verified: true }] });
  assert.equal((await get(j2, `/api/auth/oauth/github/callback?code=${state}&state=${state}`)).headers.get('location'), '/'); const again = await get(j2, `/api/auth/oauth/github/callback?code=${state}&state=${state}`); assert.match(again.headers.get('location'), /auth_error/);
  // a state minted in one browser cannot be completed from another (cookie binding)
  const a = jar(); const b = jar(); const s2 = new URL((await get(a, '/api/auth/oauth/github/start')).headers.get('location')).searchParams.get('state'); assert.match((await get(b, `/api/auth/oauth/github/callback?code=x&state=${s2}`)).headers.get('location'), /auth_error/);
});

test('takeover guard: OAuth with the same email disables a pre-registered unverified password', async () => {
  const attacker = jar(); assert.equal((await call(attacker, 'POST', '/api/auth/signup', { name: 'Mallory', email: 'victim@example.com', password: 'attacker-knows-this-1' })).status, 201);
  assert.equal((await call(attacker, 'GET', '/api/auth/me')).status, 200);
  const victim = jar(); await oauthFlow(victim, 'google', { id: 'g-victim', email: 'victim@example.com', verified: true, name: 'Vic Tim' });
  assert.equal((await call(victim, 'GET', '/api/auth/me')).body.user.email, 'victim@example.com');
  assert.equal((await call(attacker, 'GET', '/api/auth/me')).status, 401, 'attacker session revoked');
  assert.equal((await call(jar(), 'POST', '/api/auth/login', { email: 'victim@example.com', password: 'attacker-knows-this-1' })).status, 401, 'attacker password no longer works');
});

test('connect GitHub to an existing account, store the token encrypted, use it for sync, then disconnect', async () => {
  const j = jar(); assert.equal((await call(j, 'POST', '/api/auth/signup', { name: 'Pat Pass', email: 'pat@example.com', password: 'correct-horse-battery' })).status, 201);
  assert.match((await get(jar(), '/api/auth/oauth/github/start?link=1')).headers.get('location'), /auth_error=Sign%20in%20first/);
  const { cb, loc } = await oauthFlow(j, 'github', { id: 'gh-pat', login: 'patpass', name: 'Pat', emails: [{ email: 'other@example.com', primary: true, verified: true }] }, { link: true, repo: true });
  assert.equal(loc.searchParams.get('scope'), 'read:user user:email repo'); assert.equal(cb.headers.get('location'), '/?linked=github');
  const ids = (await call(j, 'GET', '/api/me/identities')).body; assert.equal(ids.identities[0].provider, 'github'); assert.equal(ids.identities[0].handle, 'patpass'); assert.equal(ids.identities[0].hasRepoAccess, true); assert.equal(ids.identities[0].tokenEnc, undefined); assert.equal(ids.hasPassword, true);
  // email on the account did not change and the token is not stored in plaintext
  assert.equal((await call(j, 'GET', '/api/auth/me')).body.user.email, 'pat@example.com');
  app.saveNow(); const raw = readFileSync(join(dir, 'state.json'), 'utf8'); assert.ok(!raw.includes('tok:'), 'no plaintext access token on disk'); assert.match(raw, /"tokenEnc":\s*"v1\./);
  // sync uses the user's own token (no server-wide GITHUB_TOKEN needed)
  const ws = (await call(j, 'POST', '/api/projects', { name: 'Sync Room' })).body.id; delete process.env.GITHUB_TOKEN;
  const sync = await call(j, 'POST', `/api/projects/${ws}/github/sync`, { owner: 'me', repo: 'repo' }); assert.equal(sync.status, 200, JSON.stringify(sync.body)); assert.ok(seenAuth.at(-1).startsWith('Bearer tok:'));
  // another account cannot claim the same GitHub identity
  const other = jar(); await call(other, 'POST', '/api/auth/signup', { name: 'Eve', email: 'eve@example.com', password: 'correct-horse-battery' });
  const stolen = await oauthFlow(other, 'github', { id: 'gh-pat', login: 'patpass', name: 'Pat', emails: [{ email: 'other@example.com', primary: true, verified: true }] }, { link: true }); assert.match(stolen.cb.headers.get('location'), /auth_error=.*already%20connected/);
  assert.equal((await call(j, 'DELETE', '/api/auth/identities/github')).status, 200); assert.equal((await call(j, 'GET', '/api/me/identities')).body.identities.length, 0);
  assert.equal((await call(j, 'DELETE', '/api/auth/identities/github')).status, 404);
});

test('cannot disconnect the only way to sign in', async () => {
  const j = jar(); await oauthFlow(j, 'google', { id: 'g-only', email: 'only@example.com', verified: true, name: 'Only One' });
  assert.equal((await call(j, 'DELETE', '/api/auth/identities/google')).status, 409);
});

test('token encryption round-trips and detects tampering', () => {
  const key = crypto.randomBytes(32); const c = encrypt(key, 'ghp_secret'); assert.equal(decrypt(key, c), 'ghp_secret'); assert.notEqual(encrypt(key, 'ghp_secret'), c);
  assert.throws(() => decrypt(key, c.slice(0, -2) + 'AA')); assert.throws(() => decrypt(crypto.randomBytes(32), c));
});

test('http vs https is decided from the request, so SECURE_COOKIES=true cannot break http://localhost', async () => {
  const { makeIsHttps } = await import('../lib/auth.mjs');
  const on = makeIsHttps({ secureCookies: true }); const off = makeIsHttps({ secureCookies: false }); const req = (host, proto) => ({ headers: { host, ...(proto ? { 'x-forwarded-proto': proto } : {}) } });
  assert.equal(on(req('localhost:4173')), false); assert.equal(on(req('127.0.0.1:4173')), false); assert.equal(on(req('hack.example.com')), true);
  assert.equal(on(req('localhost:4173', 'https')), true, 'a TLS-terminating proxy wins'); assert.equal(off(req('hack.example.com', 'http')), false); assert.equal(off(req('hack.example.com')), false);
  process.env.HACKCONNECT_BASE_URL = 'https://hack.example.com'; try { assert.equal(off(req('localhost:4173')), true); } finally { delete process.env.HACKCONNECT_BASE_URL; }
  // end to end: with the flag ON but a plain http localhost request, the cookie is not Secure and the callback URI is http
  const secureApp = createApp({ root, stateFile: join(dir, 'secure.json'), authLimit: 1000, secureCookies: true, autoBackupMinutes: 0 }); await new Promise((r) => secureApp.server.listen(0, '127.0.0.1', r));
  try {
    const b = `http://localhost:${secureApp.server.address().port}`;
    const start = await fetch(`${b}/api/auth/oauth/github/start`, { redirect: 'manual' }); assert.match(new URL(start.headers.get('location')).searchParams.get('redirect_uri'), /^http:\/\/localhost:\d+\/api\/auth\/oauth\/github\/callback$/); assert.ok(!/Secure/.test(start.headers.getSetCookie().join(';')));
    const su = await fetch(`${b}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect' }, body: JSON.stringify({ name: 'Local Host', email: 'lh@example.com', password: 'correct-horse-battery' }) }); assert.equal(su.status, 201); assert.ok(!/Secure/.test(su.headers.get('set-cookie')), 'session cookie must be usable on http://localhost');
    const behindProxy = await fetch(`${b}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect', 'x-forwarded-proto': 'https' }, body: JSON.stringify({ email: 'lh@example.com', password: 'correct-horse-battery' }) }); assert.match(behindProxy.headers.get('set-cookie'), /; Secure/);
  } finally { await secureApp.close(); }
});

test('a GITHUB_TOKEN in the environment is ignored: sync needs the user to connect their own GitHub', async () => {
  process.env.GITHUB_TOKEN = 'ghp_' + 'z'.repeat(36); const before = seenAuth.length;
  try {
    const j = jar(); await call(j, 'POST', '/api/auth/signup', { name: 'No Link', email: 'nolink@example.com', password: 'correct-horse-battery' });
    const ws = (await call(j, 'POST', '/api/projects', { name: 'Unlinked Room' })).body.id;
    const sync = await call(j, 'POST', `/api/projects/${ws}/github/sync`, { owner: 'me', repo: 'repo' }); assert.equal(sync.status, 502); assert.match(sync.body.error, /Connect your GitHub account/);
    assert.equal(seenAuth.length, before, 'no request reached GitHub with the environment token');
    const status = (await call(j, 'GET', '/api/integrations/status')).body; assert.equal(status.github, false); assert.equal(status.githubSignIn, true);
    assert.equal((await call(j, 'GET', '/api/bootstrap')).body.integrations.github, false);
  } finally { delete process.env.GITHUB_TOKEN; }
});

test('with canonicalLocalhost, starting sign-in from 127.0.0.1 continues on localhost so the registered callback and cookie match', async () => {
  const canon = createApp({ root, stateFile: join(dir, 'canon.json'), authLimit: 1000, canonicalLocalhost: true, autoBackupMinutes: 0 }); await new Promise((r) => canon.server.listen(0, '127.0.0.1', r)); const port = canon.server.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/auth/oauth/google/start?x=1`, { redirect: 'manual' });
    assert.equal(r.status, 302); assert.equal(r.headers.get('location'), `http://localhost:${port}/api/auth/oauth/google/start?x=1`); assert.equal(r.headers.getSetCookie().length, 0, 'no state cookie is set on the wrong host');
    const again = await fetch(`http://localhost:${port}/api/auth/oauth/google/start`, { redirect: 'manual' }); assert.match(new URL(again.headers.get('location')).searchParams.get('redirect_uri'), new RegExp(`^http://localhost:${port}/`));
    process.env.HACKCONNECT_BASE_URL = 'https://hack.example.com'; try { const withBase = await fetch(`http://127.0.0.1:${port}/api/auth/oauth/google/start`, { redirect: 'manual' }); assert.match(withBase.headers.get('location'), /^http:\/\/127\.0\.0\.1:|^http:\/\/localhost|mock/); assert.ok(!withBase.headers.get('location').startsWith(`http://localhost:${port}/api/auth`)); } finally { delete process.env.HACKCONNECT_BASE_URL; }
  } finally { await canon.close(); }
});
