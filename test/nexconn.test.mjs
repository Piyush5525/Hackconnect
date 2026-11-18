// Team hub server side (lib/nexconn.mjs) against a fake Nexconn Platform API: request signing, access tokens,
// channels that follow project membership, discussion threads, join notices, profile lookups and the shared assistant's reply.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../lib/app.mjs';
import { nxUserId, BOT, plainText } from '../lib/nexconn.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)); const KEY = 'testappkey'; const SECRET = 'test-secret-never-leaves';
let app, base, dir, plain, plainBase, plainDir; const env = { NEXCONN_KEY: KEY, NEXCONN_SECRET: SECRET }; const calls = []; const groups = new Map(); let failNext = null;

/** A stand-in for https://api.sg-light-api.com that checks the signature and remembers groups. */
const fakeFetch = async (url, init) => {
  const path = new URL(url).pathname; const h = init.headers; const body = JSON.parse(init.body); calls.push({ url, path, headers: h, body });
  const ok = (data = {}) => new Response(JSON.stringify({ code: 0, ...data }), { status: 200 });
  if (h.Signature !== crypto.createHash('sha1').update(SECRET + h.Nonce + h.Timestamp).digest('hex') || h['App-Key'] !== env.NEXCONN_KEY) return new Response(JSON.stringify({ code: 401, errorMessage: 'bad signature' }), { status: 401 });
  if (failNext === path) { failNext = null; return new Response(JSON.stringify({ code: 500, errorMessage: 'boom' }), { status: 500 }); }
  if (path === '/v4/auth/access-token/issue') return ok({ result: { userId: body.userId, accessToken: `tok-${body.userId}` } });
  if (path === '/v4/group-channel/create') { groups.set(body.channelId, new Set([body.owner, ...(body.userIds || [])])); return ok(); }
  if (['/v4/group-channel/join', '/v4/group-channel/leave'].includes(path) && !groups.has(body.channelId)) return new Response(JSON.stringify({ code: 20003, errorMessage: 'group not exist' }), { status: 200 });
  if (path === '/v4/group-channel/join') { for (const id of body.userIds) groups.get(body.channelId).add(id); return ok(); }
  if (path === '/v4/group-channel/leave') { for (const id of body.userIds) groups.get(body.channelId).delete(id); return ok(); }
  if (path === '/v4/group-channel/dismiss') { groups.delete(body.channelId); return ok(); }
  if (path === '/v4/group-channel/message/send') return ok({ result: { messageIds: [{ channelId: body.toChannelIds[0], messageId: 'MSG-1' }] } });
  return new Response(JSON.stringify({ code: 404, errorMessage: 'unknown path' }), { status: 404 });
};

const listen = async (instance) => { await new Promise((r) => instance.server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${instance.server.address().port}`; };
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hc-nx-')); app = createApp({ root, stateFile: join(dir, 's.json'), authLimit: 1e6, autoBackupMinutes: 0, nexconnOptions: { fetchImpl: fakeFetch, env } }); base = await listen(app);
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
  assert.equal(first.enabled, true); assert.equal(first.appKey, KEY); assert.equal(first.areaCode, 2, 'Singapore area code for the browser SDK'); assert.equal(first.userId, u.nx); assert.equal(first.token, `tok-${u.nx}`); assert.ok(!JSON.stringify(first).includes(SECRET));
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
  const sent = calls.filter((c) => c.path === '/v4/group-channel/message/send' && c.body.content.includes('askedBy')).pop(); assert.equal(sent.body.fromUserId, BOT.id); assert.deepEqual(sent.body.toChannelIds, [general.id]); assert.equal(sent.body.messageType, 'RC:TxtMsg');
  const content = JSON.parse(sent.body.content); assert.ok(content.content.length > 10); assert.equal(content.user.name, BOT.name); assert.deepEqual(JSON.parse(content.extra), { ai: true, provider: 'demo', askedBy: 'Ask Owner' });
  assert.ok(calls.some((c) => c.path === '/v4/auth/access-token/issue' && c.body.userId === BOT.id), 'the bot user is registered before it speaks');
});

const settle = () => new Promise((r) => setTimeout(r, 50));
test('a new member is welcomed in #general by the bot', async () => {
  const owner = await person('Welcome Owner', 'welowner@x.io'); const mate = await person('Welcome Mate', 'welmate@x.io'); const pid = (await owner.call('POST', '/api/projects', { name: 'Welcome' })).body.id;
  const general = (await owner.call('GET', '/api/hub')).body.projects.find((x) => x.id === pid).channels.find((c) => c.key === 'general');
  const welcomes = () => calls.filter((c) => c.path === '/v4/group-channel/message/send' && c.body.toChannelIds[0] === general.id);
  await settle(); assert.equal(welcomes().length, 0, 'creating the project does not post a join notice');
  await join2(owner, mate, pid); await owner.call('GET', '/api/hub'); await settle();
  const [notice] = welcomes(); assert.ok(notice, 'a join notice was posted'); assert.equal(notice.body.fromUserId, BOT.id); assert.match(JSON.parse(notice.body.content).content, /Welcome Mate joined Welcome/);
});

test('profiles for unknown Nexconn ids come from HackConnect, without private fields', async () => {
  const a = await person('Lookup A', 'lookupa@x.io'); const b = await person('Lookup B', 'lookupb@x.io');
  const r = (await a.call('POST', '/api/hub/people', { ids: [b.nx, BOT.id, 'unobody'] })).body.people;
  assert.deepEqual(r.map((p) => p.nx).sort(), [b.nx, BOT.id].sort()); const pb = r.find((p) => p.nx === b.nx); assert.equal(pb.name, 'Lookup B'); assert.deepEqual(Object.keys(pb).sort(), ['avatar', 'name', 'nx']);
  assert.equal((await fetch(`${base}/api/hub/people`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect' }, body: '{"ids":[]}' })).status, 401);
});

test('switching to another Nexconn app recreates the channels instead of using dead ones', async () => {
  const owner = await person('Switch Owner', 'switch@x.io'); const pid = (await owner.call('POST', '/api/projects', { name: 'Switch' })).body.id;
  const oldIds = (await owner.call('GET', '/api/hub')).body.projects.find((x) => x.id === pid).channels.map((c) => c.id);
  const saved = env.NEXCONN_KEY; env.NEXCONN_KEY = 'otherappkey';
  try {
    const session = (await owner.call('GET', '/api/nexconn/session')).body; assert.equal(session.appKey, 'otherappkey');
    const now = (await owner.call('GET', '/api/hub')).body.projects.find((x) => x.id === pid); assert.deepEqual(now.channels.map((c) => c.kind), ['general', 'handover']);
    assert.ok(now.channels.every((c) => !oldIds.includes(c.id)), 'fresh channels on the new app'); for (const c of now.channels) assert.ok(groups.get(c.id).has(owner.nx));
  } finally { env.NEXCONN_KEY = saved; }
});

test('assistant answers are posted as plain text (ChatUI does not render Markdown)', () => {
  assert.equal(plainText('## Plan\n**Ship** the _login_ first, then `npm test`.\n* one\n* two'), 'Plan\nShip the login first, then npm test.\n- one\n- two');
  assert.equal(plainText('Run:\n```bash\nnpm start\n```\nSee [docs](https://x.io/a).'), 'Run:\nnpm start\nSee docs (https://x.io/a).');
  assert.equal(plainText('snake_case_name stays and 2*3*4 stays'), 'snake_case_name stays and 2*3*4 stays');
});

test('a channel Nexconn no longer knows (left over from another app) is replaced on the next sync', async () => {
  const owner = await person('Stale Owner', 'stale@x.io'); const mate = await person('Stale Mate', 'stalemate@x.io'); const pid = (await owner.call('POST', '/api/projects', { name: 'Stale' })).body.id;
  const first = (await owner.call('GET', '/api/hub')).body.projects.find((x) => x.id === pid).channels; for (const c of first) groups.delete(c.id); // gone on the Nexconn side
  await join2(owner, mate, pid); const now = (await mate.call('GET', '/api/hub')).body.projects.find((x) => x.id === pid);
  assert.equal(now.ready, true); assert.deepEqual(now.channels.map((c) => c.kind), ['general', 'handover']); assert.ok(now.channels.every((c) => !first.some((f) => f.id === c.id)), 'fresh channels');
  for (const c of now.channels) assert.deepEqual([...groups.get(c.id)].sort(), [owner.nx, mate.nx].sort());
});

test('project chat sent through the HackConnect API is delivered to #general on Nexconn as that person', async () => {
  const owner = await person('Chat Owner', 'chatowner@x.io'); const pid = (await owner.call('POST', '/api/projects', { name: 'Chatty' })).body.id;
  const r = await owner.call('POST', `/api/projects/${pid}/messages`, { text: 'hello from the bridge' }); assert.equal(r.status, 201); assert.equal(r.body.via, 'nexconn');
  const general = (await owner.call('GET', '/api/hub')).body.projects.find((x) => x.id === pid).channels.find((c) => c.key === 'general');
  const sent = calls.filter((c) => c.path === '/v4/group-channel/message/send' && c.body.toChannelIds[0] === general.id).pop();
  assert.equal(sent.body.fromUserId, owner.nx); assert.equal(JSON.parse(sent.body.content).content, 'hello from the bridge');
  assert.deepEqual((await owner.call('GET', `/api/projects/${pid}`)).body.messages, [], 'nothing is kept in HackConnect\'s own chat store');
});

test('a member who joins while a sync is running is still added to the channels', async () => {
  const owner = await person('Race Owner', 'raceowner@x.io'); const mate = await person('Race Mate', 'racemate@x.io'); const pid = (await owner.call('POST', '/api/projects', { name: 'Race' })).body.id;
  const first = owner.call('GET', '/api/hub'); // creating the channels takes a few calls
  await join2(owner, mate, pid); await Promise.all([first, mate.call('GET', '/api/hub')]);
  const p = (await owner.call('GET', '/api/hub')).body.projects.find((x) => x.id === pid);
  for (const c of p.channels) assert.ok(groups.get(c.id).has(mate.nx), `the late joiner is in #${c.name}`);
});
