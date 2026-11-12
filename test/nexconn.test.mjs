// Team hub server side (lib/nexconn.mjs) against a fake Nexconn Platform API: request signing, access tokens,
// channels that follow project membership, discussion threads, and the shared assistant's reply.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../lib/app.mjs';
import { nxUserId, BOT } from '../lib/nexconn.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)); const KEY = 'testappkey'; const SECRET = 'test-secret-never-leaves';
let app, base, dir, plain, plainBase, plainDir; const calls = []; const groups = new Map(); let failNext = null;

/** A stand-in for https://api.sg-light-api.com that checks the signature and remembers groups. */
const fakeFetch = async (url, init) => {
  const path = new URL(url).pathname; const h = init.headers; const body = JSON.parse(init.body); calls.push({ url, path, headers: h, body });
  const ok = (data = {}) => new Response(JSON.stringify({ code: 0, ...data }), { status: 200 });
  if (h.Signature !== crypto.createHash('sha1').update(SECRET + h.Nonce + h.Timestamp).digest('hex') || h['App-Key'] !== KEY) return new Response(JSON.stringify({ code: 401, errorMessage: 'bad signature' }), { status: 401 });
  if (failNext === path) { failNext = null; return new Response(JSON.stringify({ code: 500, errorMessage: 'boom' }), { status: 500 }); }
  if (path === '/v4/auth/access-token/issue') return ok({ result: { userId: body.userId, accessToken: `tok-${body.userId}` } });
  if (path === '/v4/group-channel/create') { groups.set(body.channelId, new Set([body.owner, ...(body.userIds || [])])); return ok(); }
  if (path === '/v4/group-channel/join') { for (const id of body.userIds) groups.get(body.channelId).add(id); return ok(); }
  if (path === '/v4/group-channel/leave') { for (const id of body.userIds) groups.get(body.channelId).delete(id); return ok(); }
  if (path === '/v4/group-channel/dismiss') { groups.delete(body.channelId); return ok(); }
  if (path === '/v4/group-channel/message/send') return ok({ result: { messageIds: [{ channelId: body.toChannelIds[0], messageId: 'MSG-1' }] } });
  return new Response(JSON.stringify({ code: 404, errorMessage: 'unknown path' }), { status: 404 });
};

const listen = async (instance) => { await new Promise((r) => instance.server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${instance.server.address().port}`; };
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hc-nx-')); app = createApp({ root, stateFile: join(dir, 's.json'), authLimit: 1e6, autoBackupMinutes: 0, nexconnOptions: { fetchImpl: fakeFetch, env: { NEXCONN_KEY: KEY, NEXCONN_SECRET: SECRET } } }); base = await listen(app);
  plainDir = mkdtempSync(join(tmpdir(), 'hc-nx0-')); plain = createApp({ root, stateFile: join(plainDir, 's.json'), authLimit: 1e6, autoBackupMinutes: 0, nexconnOptions: { fetchImpl: fakeFetch, env: {} } }); plainBase = await listen(plain);
});
after(async () => { await app.close(); await plain.close(); rmSync(dir, { recursive: true, force: true }); rmSync(plainDir, { recursive: true, force: true }); });

const person = async (name, email, at = base) => { let cookie = ''; const call = async (method, path, body) => { const res = await fetch(at + path, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const set = res.headers.get('set-cookie'); if (set && /hc_session/.test(set)) cookie = set.split(';')[0]; return { status: res.status, body: await res.json().catch(() => ({})) }; }; const r = await call('POST', '/api/auth/signup', { name, email, password: 'correct-horse-battery' }); return { call, id: r.body.user.id, nx: nxUserId(r.body.user.id) }; };
const join2 = async (owner, guest, pid, role = 'editor') => { const invite = (await owner.call('POST', `/api/projects/${pid}/invites`, { role })).body; const r = await guest.call('POST', `/api/invites/${invite.token}/accept`); assert.ok(r.status < 300, `invite accepted (${r.status})`); };

test('Nexconn user ids are letters and digits only', () => { assert.match(nxUserId('0b2f-11aa-zz'), /^u[a-zA-Z0-9]+$/); assert.equal(nxUserId('a-b_c.d'), 'uabcd'); });

test('without keys the hub reports "not configured" and nothing calls Nexconn', async () => {
  const u = await person('No Keys', 'nokeys@x.io', plainBase); const before = calls.length;
  assert.deepEqual((await u.call('GET', '/api/nexconn/session')).body, { enabled: false }); const hub = (await u.call('GET', '/api/hub')).body; assert.equal(hub.enabled, false); assert.deepEqual(hub.projects, []);
  const pid = (await u.call('POST', '/api/projects', { name: 'Plain' })).body.id; assert.equal((await u.call('POST', `/api/projects/${pid}/channels`, { name: 'ideas' })).status, 503);
  assert.equal((await u.call('GET', '/api/bootstrap')).body.integrations.nexconn, false); assert.equal(calls.length, before);
});

test('session: needs sign-in, returns a per-person token and never the app secret', async () => {
  assert.equal((await fetch(`${base}/api/nexconn/session`)).status, 401);
  const u = await person('Token Owner', 'token@x.io'); const first = (await u.call('GET', '/api/nexconn/session')).body;
  assert.equal(first.enabled, true); assert.equal(first.appKey, KEY); assert.equal(first.userId, u.nx); assert.equal(first.token, `tok-${u.nx}`); assert.ok(!JSON.stringify(first).includes(SECRET));
  const issued = calls.filter((c) => c.path === '/v4/auth/access-token/issue' && c.body.userId === u.nx).length; await u.call('GET', '/api/nexconn/session');
  assert.equal(calls.filter((c) => c.path === '/v4/auth/access-token/issue' && c.body.userId === u.nx).length, issued, 'the token is reused, not re-issued on every page load');
  assert.ok(calls.every((c) => c.url.startsWith('https://api.sg-light-api.com/')), 'Singapore data center by default'); assert.ok(calls.every((c) => !JSON.stringify(c.body).includes(SECRET)));
  app.saveNow(); assert.ok(!readFileSync(join(dir, 's.json'), 'utf8').includes(SECRET), 'the secret is never written to the state file');
  assert.equal((await u.call('GET', '/api/bootstrap')).body.integrations.nexconn, true);
});

test('a project gets #general and #handover, and the groups follow project membership', async () => {
  const owner = await person('Hub Owner', 'hubowner@x.io'); const mate = await person('Hub Mate', 'hubmate@x.io'); const pid = (await owner.call('POST', '/api/projects', { name: 'Hub Project' })).body.id;
  const hub = (await owner.call('GET', '/api/hub')).body; const p = hub.projects.find((x) => x.id === pid); assert.deepEqual(p.channels.map((c) => c.kind), ['general', 'handover']); assert.equal(p.ready, true); assert.equal(hub.me, owner.nx);
  for (const c of p.channels) assert.deepEqual([...groups.get(c.id)], [owner.nx]); assert.match(p.channels[0].id, /^c[a-f0-9]+$/, 'channel ids are letters and digits');
  const again = (await owner.call('GET', '/api/hub')).body.projects.find((x) => x.id === pid); assert.deepEqual(again.channels.map((c) => c.id), p.channels.map((c) => c.id), 'channels are created once');
  assert.equal((await mate.call('GET', '/api/hub')).body.projects.length, 0, 'not a member yet: sees nothing');
  await join2(owner, mate, pid); const mine = (await mate.call('GET', '/api/hub')).body; assert.equal(mine.projects[0].members.length, 2); assert.equal(mine.people[owner.nx].name, 'Hub Owner'); assert.equal(mine.people[BOT.id].bot, true);
  for (const c of p.channels) assert.ok(groups.get(c.id).has(mate.nx), 'the new member was added to every channel');
  assert.equal((await owner.call('DELETE', `/api/projects/${pid}/members/${mate.id}`)).status, 200); await owner.call('GET', '/api/hub');
  for (const c of p.channels) assert.ok(!groups.get(c.id).has(mate.nx), 'a removed member is taken out of every channel');
  assert.equal((await mate.call('GET', '/api/hub')).body.projects.length, 0);
});

test('threads: validation, duplicates, permissions, archive', async () => {
  const owner = await person('Thread Owner', 'thowner@x.io'); const editor = await person('Thread Editor', 'theditor@x.io'); const viewer = await person('Thread Viewer', 'thviewer@x.io'); const outsider = await person('Thread Outsider', 'thout@x.io');
  const pid = (await owner.call('POST', '/api/projects', { name: 'Threads' })).body.id; await join2(owner, editor, pid, 'editor'); await join2(owner, viewer, pid, 'viewer');
  assert.equal((await outsider.call('POST', `/api/projects/${pid}/channels`, { name: 'sneaky' })).status, 404); assert.equal((await viewer.call('POST', `/api/projects/${pid}/channels`, { name: 'ideas' })).status, 403);
  assert.equal((await editor.call('POST', `/api/projects/${pid}/channels`, { name: '!' })).status, 400);
  const made = await editor.call('POST', `/api/projects/${pid}/channels`, { name: 'API Design!', topic: 'REST shape' }); assert.equal(made.status, 201); assert.equal(made.body.name, 'api-design'); assert.equal(made.body.kind, 'thread');
  assert.equal(groups.get(made.body.id).size, 3, 'everyone on the project is in the new thread'); assert.equal((await owner.call('POST', `/api/projects/${pid}/channels`, { name: 'api design' })).status, 409);
  const general = (await owner.call('GET', '/api/hub')).body.projects.find((x) => x.id === pid).channels[0];
  assert.equal((await owner.call('DELETE', `/api/projects/${pid}/channels/${general.id}`)).status, 400, 'default channels stay'); assert.equal((await viewer.call('DELETE', `/api/projects/${pid}/channels/${made.body.id}`)).status, 403);
  assert.equal((await editor.call('DELETE', `/api/projects/${pid}/channels/${made.body.id}`)).status, 200); assert.ok(!groups.has(made.body.id)); assert.equal((await owner.call('GET', '/api/hub')).body.projects.find((x) => x.id === pid).channels.length, 2);
  failNext = '/v4/group-channel/create'; assert.equal((await owner.call('POST', `/api/projects/${pid}/channels`, { name: 'flaky' })).status, 502, 'a Nexconn failure is reported, not swallowed');
  assert.equal((await owner.call('GET', '/api/hub')).body.projects.find((x) => x.id === pid).channels.length, 2, 'nothing half-created is kept');
});

test('the shared assistant answers into the channel as the bot', async () => {
  const owner = await person('Ask Owner', 'askowner@x.io'); const viewer = await person('Ask Viewer', 'askviewer@x.io'); const pid = (await owner.call('POST', '/api/projects', { name: 'Ask' })).body.id; await join2(owner, viewer, pid, 'viewer');
  const general = (await owner.call('GET', '/api/hub')).body.projects.find((x) => x.id === pid).channels[0];
  assert.equal((await owner.call('POST', `/api/projects/${pid}/channels/${general.id}/ask`, { prompt: '  ' })).status, 400); assert.equal((await viewer.call('POST', `/api/projects/${pid}/channels/${general.id}/ask`, { prompt: 'hi' })).status, 403);
  assert.equal((await owner.call('POST', `/api/projects/${pid}/channels/nope/ask`, { prompt: 'hi' })).status, 404);
  const saved = process.env.HACKCONNECT_AGENT_PROVIDER; process.env.HACKCONNECT_AGENT_PROVIDER = 'demo';
  try { const r = await owner.call('POST', `/api/projects/${pid}/channels/${general.id}/ask`, { prompt: 'What should we build first?' }); assert.equal(r.status, 200); assert.equal(r.body.messageId, 'MSG-1'); } finally { if (saved === undefined) delete process.env.HACKCONNECT_AGENT_PROVIDER; else process.env.HACKCONNECT_AGENT_PROVIDER = saved; }
  const sent = calls.filter((c) => c.path === '/v4/group-channel/message/send').pop(); assert.equal(sent.body.fromUserId, BOT.id); assert.deepEqual(sent.body.toChannelIds, [general.id]); assert.equal(sent.body.messageType, 'RC:TxtMsg');
  const content = JSON.parse(sent.body.content); assert.ok(content.content.length > 10); assert.deepEqual(JSON.parse(content.extra), { ai: true, provider: 'demo', askedBy: 'Ask Owner' });
  assert.ok(calls.some((c) => c.path === '/v4/auth/access-token/issue' && c.body.userId === BOT.id), 'the bot user is registered before it speaks');
});
