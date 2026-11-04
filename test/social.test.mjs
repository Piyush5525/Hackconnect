import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../lib/app.mjs';
import { makeUsername, isValidUsername } from '../lib/social.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
let app, base, dir;
before(async () => { dir = mkdtempSync(join(tmpdir(), 'hc-social-')); app = createApp({ root, stateFile: join(dir, 's.json'), authLimit: 1e6, autoBackupMinutes: 0 }); await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${app.server.address().port}`; });
after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

const person = async (name, email, username) => { let cookie = ''; const call = async (method, path, body) => { const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const set = res.headers.get('set-cookie'); if (set && /hc_session/.test(set)) cookie = set.split(';')[0]; return { status: res.status, body: await res.json().catch(() => ({})) }; }; const r = await call('POST', '/api/auth/signup', { name, email, password: 'correct-horse-battery', ...(username ? { username } : {}) }); return { call, r, id: r.body.user?.id, username: r.body.user?.username }; };

test('username rules and generation', () => {
  for (const ok of ['ada', 'ada_l', 'a-b-c', 'x1y2z3', 'piyush-agarwal']) assert.ok(isValidUsername(ok), ok);
  for (const bad of ['ab', 'A', 'Ada', '-ada', '_ada', 'ada lovelace', 'ada@x', 'a'.repeat(31), 'admin', 'root', 'api', 'me', 'ünï']) assert.ok(!isValidUsername(bad), bad);
  const db = { users: [{ username: 'piyush-agarwal' }] };
  assert.equal(makeUsername(db, 'Maya Shah', 'maya@x.io'), 'maya-shah'); assert.match(makeUsername(db, 'Piyush Agarwal'), /^piyush-agarwal-\d{4}$/); assert.equal(makeUsername(db, null, 'jia.rao@x.io'), 'jia-rao'); assert.match(makeUsername(db, '??', '!!'), /^builder-\d{4}$|^user-/);
});

test('every account gets a unique username; chosen ones are validated and checked for availability', async () => {
  const a = await person('Piyush Agarwal', 'piyush@x.io'); assert.equal(a.username, 'piyush-agarwal');
  const b = await person('Piyush Agarwal', 'piyush2@x.io'); assert.notEqual(b.username, a.username, 'same name gets a different handle'); assert.match(b.username, /^piyush/);
  const c = await person('Chosen', 'chosen@x.io', '@Cool_Dev'); assert.equal(c.username, 'cool_dev');
  assert.equal((await person('Dup', 'dup@x.io', 'COOL_DEV')).r.status, 409); assert.equal((await person('Bad', 'bad@x.io', 'no spaces!')).r.status, 400); assert.equal((await person('Rsv', 'rsv@x.io', 'admin')).r.status, 400);
  const anon = await (await fetch(`${base}/api/auth/username-available?u=cool_dev`)).json(); assert.deepEqual([anon.valid, anon.available], [true, false]); const free = await (await fetch(`${base}/api/auth/username-available?u=totally-free`)).json(); assert.deepEqual([free.valid, free.available], [true, true]); const inval = await (await fetch(`${base}/api/auth/username-available?u=A`)).json(); assert.equal(inval.valid, false); assert.ok(inval.suggestion);
  assert.equal((await a.call('GET', '/api/auth/me')).body.user.username, 'piyush-agarwal');
});

test('change username and profile; search and profile lookup never expose emails', async () => {
  const me = await person('Rename Me', 'rename@x.io'); const other = await person('Searchable Sam', 'sam@x.io', 'sam-builds');
  assert.equal((await me.call('PATCH', '/api/me', { username: 'sam-builds' })).status, 409); assert.equal((await me.call('PATCH', '/api/me', { username: 'Bad Name' })).status, 400);
  const ok = await me.call('PATCH', '/api/me', { username: 'renamed-dev', bio: 'I build things' }); assert.equal(ok.status, 200); assert.equal(ok.body.user.username, 'renamed-dev'); assert.equal((await me.call('PATCH', '/api/me', { username: 'again-soon' })).status, 429, 'rate limited');
  const found = (await me.call('GET', '/api/users/search?q=sam')).body.users; assert.ok(found.some((u) => u.username === 'sam-builds')); assert.ok(found.every((u) => u.email === undefined && !('passwordHash' in u))); assert.equal((await me.call('GET', '/api/users/search?q=s')).body.users.length, 0);
  assert.ok(!(await me.call('GET', '/api/users/search?q=rename')).body.users.some((u) => u.username === 'renamed-dev'), 'you do not find yourself');
  const profile = await me.call('GET', '/api/users/sam-builds'); assert.equal(profile.body.user.name, 'Searchable Sam'); assert.equal(profile.body.user.email, undefined); assert.equal((await me.call('GET', '/api/users/nobody-here')).status, 404);
  assert.equal((await fetch(`${base}/api/users/sam-builds`)).status, 401, 'sign in required'); void other;
});

test('connection requests: send, accept, decline, no duplicates', async () => {
  const a = await person('Alice A', 'alice@x.io', 'alice-a'); const b = await person('Bob B', 'bob@x.io', 'bob-b'); const c = await person('Cy C', 'cy@x.io', 'cy-c');
  assert.equal((await a.call('POST', '/api/connections', { username: 'nobody' })).status, 404); assert.equal((await a.call('POST', '/api/connections', { username: 'alice-a' })).status, 400);
  const req1 = await a.call('POST', '/api/connections', { username: '@bob-b' }); assert.equal(req1.status, 201); assert.equal((await a.call('POST', '/api/connections', { username: 'bob-b' })).status, 409); assert.equal((await b.call('POST', '/api/connections', { username: 'alice-a' })).status, 409);
  assert.ok(app.db.notifications.some((n) => n.userId === b.id && /@alice-a/.test(n.text)));
  assert.equal((await a.call('POST', `/api/connections/${req1.body.id}/accept`, {})).status, 404, 'only the recipient can accept');
  assert.equal((await b.call('GET', '/api/me/connections')).body.incoming.length, 1); assert.equal((await a.call('GET', '/api/me/connections')).body.outgoing.length, 1);
  assert.equal((await b.call('POST', `/api/connections/${req1.body.id}/accept`, {})).status, 200); assert.equal((await a.call('GET', '/api/me/connections')).body.connections[0].user.username, 'bob-b');
  assert.equal((await a.call('GET', '/api/users/bob-b')).body.connection.status, 'accepted');
  const req2 = await a.call('POST', '/api/connections', { username: 'cy-c' }); assert.equal((await c.call('POST', `/api/connections/${req2.body.id}/decline`, {})).status, 200); assert.equal((await a.call('GET', '/api/me/connections')).body.outgoing.length, 0);
  assert.equal((await a.call('DELETE', `/api/connections/${req1.body.id}`)).status, 200); assert.equal((await b.call('GET', '/api/me/connections')).body.connections.length, 0);
});

test('invite a person to a project by username: permissions, accept, decline, no duplicates', async () => {
  const owner = await person('Olive O', 'olive@x.io', 'olive-o'); const guest = await person('Gus G', 'gus@x.io', 'gus-g'); const rando = await person('Ray R', 'ray@x.io', 'ray-r'); const editor = await person('Eddie E', 'eddie@x.io', 'eddie-e');
  const ws = (await owner.call('POST', '/api/projects', { name: 'Invite Room' })).body.id;
  assert.equal((await rando.call('POST', `/api/projects/${ws}/invite-user`, { username: 'gus-g' })).status, 404, 'non-members cannot even see the project');
  assert.equal((await owner.call('POST', `/api/projects/${ws}/invite-user`, { username: 'nobody-x' })).status, 404); assert.equal((await owner.call('POST', `/api/projects/${ws}/invite-user`, { username: 'gus-g', role: 'god' })).status, 400); assert.equal((await owner.call('POST', `/api/projects/${ws}/invite-user`, { username: 'olive-o' })).status, 400);
  const inv = await owner.call('POST', `/api/projects/${ws}/invite-user`, { username: 'gus-g', role: 'viewer' }); assert.equal(inv.status, 201); assert.equal((await owner.call('POST', `/api/projects/${ws}/invite-user`, { username: 'gus-g' })).status, 409, 'one pending invitation');
  assert.equal((await guest.call('GET', `/api/projects/${ws}`)).status, 404, 'not a member until accepted');
  const mine = (await guest.call('GET', '/api/me/invitations')).body.invitations; assert.equal(mine.length, 1); assert.equal(mine[0].from.username, 'olive-o'); assert.equal(mine[0].target.name, 'Invite Room'); assert.equal(mine[0].role, 'viewer');
  assert.equal((await rando.call('POST', `/api/invitations/${inv.body.id}/accept`, {})).status, 404, 'only the invited person can accept');
  const accepted = await guest.call('POST', `/api/invitations/${inv.body.id}/accept`, {}); assert.equal(accepted.status, 200); assert.equal((await guest.call('GET', `/api/projects/${ws}`)).body.project.role, 'viewer');
  assert.equal((await guest.call('POST', `/api/invitations/${inv.body.id}/accept`, {})).status, 404, 'one-time'); assert.equal((await owner.call('POST', `/api/projects/${ws}/invite-user`, { username: 'gus-g' })).status, 409, 'already a member');
  // a viewer cannot invite; an editor cannot either (owners only)
  assert.equal((await guest.call('POST', `/api/projects/${ws}/invite-user`, { username: 'ray-r' })).status, 403);
  const inv2 = await owner.call('POST', `/api/projects/${ws}/invite-user`, { username: 'eddie-e', role: 'editor' }); await editor.call('POST', `/api/invitations/${inv2.body.id}/accept`, {}); assert.equal((await editor.call('POST', `/api/projects/${ws}/invite-user`, { username: 'ray-r' })).status, 403);
  // decline and cancel
  const inv3 = await owner.call('POST', `/api/projects/${ws}/invite-user`, { username: 'ray-r' }); assert.equal((await rando.call('POST', `/api/invitations/${inv3.body.id}/decline`, {})).body.status, 'declined'); assert.equal((await rando.call('GET', `/api/projects/${ws}`)).status, 404);
  const inv4 = await owner.call('POST', `/api/projects/${ws}/invite-user`, { username: 'ray-r' }); assert.equal((await owner.call('GET', '/api/me/invitations')).body.sent.length, 1); assert.equal((await owner.call('DELETE', `/api/invitations/${inv4.body.id}`)).status, 200); assert.equal((await rando.call('POST', `/api/invitations/${inv4.body.id}/accept`, {})).status, 404);
  assert.ok(app.db.notifications.some((n) => n.userId === owner.id && /accepted your invitation/.test(n.text)));
  const members = (await owner.call('GET', `/api/projects/${ws}/members`)).body.members; assert.ok(members.every((m) => m.username));
});

test('team invitations by username', async () => {
  const lead = await person('Tara T', 'tara@x.io', 'tara-t'); const mate = await person('Max M', 'max@x.io', 'max-m'); const t = (await lead.call('POST', '/api/teams', { name: 'Rocket' })).body;
  const inv = await lead.call('POST', `/api/teams/${t.id}/invite-user`, { username: 'max-m' }); assert.equal(inv.status, 201); assert.equal((await mate.call('POST', `/api/invitations/${inv.body.id}/accept`, {})).body.kind, 'team'); assert.equal((await mate.call('GET', `/api/teams/${t.id}`)).status, 200);
  assert.equal((await mate.call('POST', `/api/teams/${t.id}/invite-user`, { username: 'tara-t' })).status, 403);
});
