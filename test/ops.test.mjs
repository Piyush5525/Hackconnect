import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../lib/app.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const boot = async (stateFile, opts = {}) => { const app = createApp({ root, stateFile, authLimit: 1e6, autoBackupMinutes: 0, ...opts }); await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); app.base = `http://127.0.0.1:${app.server.address().port}`; return app; };
const person = async (app, name, email) => { let cookie = ''; const call = async (method, path, body) => { const res = await fetch(app.base + path, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]; return { status: res.status, body: await res.json().catch(() => ({})) }; }; const r = await call('POST', '/api/auth/signup', { name, email, password: 'correct-horse-battery' }); return { call, id: r.body.user.id }; };

test('deadline scheduler warns, then freezes workspaces and starts judging by itself', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hc-ops-')); const app = await boot(join(dir, 's.json'));
  try {
    const org = await person(app, 'Org O', 'org@x.io'); const dev = await person(app, 'Dev D', 'dev@x.io');
    const ev = (await org.call('POST', '/api/events', { title: 'Timed Hack', agentPolicy: 'allowed' })).body; await org.call('PATCH', `/api/events/${ev.id}`, { status: 'registration' }); await dev.call('POST', `/api/events/${ev.id}/register`, {});
    const team = (await dev.call('POST', `/api/events/${ev.id}/teams`, { name: 'Late' })).body; await org.call('PATCH', `/api/events/${ev.id}`, { status: 'hacking' });
    const deadline = Date.now() + 3600_000; assert.equal((await org.call('PATCH', `/api/events/${ev.id}`, { deadline })).status, 200);
    app.tick(deadline - 3600_000 + 1000); assert.equal(app.db.events[0].status, 'hacking'); // still an hour away
    app.tick(deadline - 10 * 60000); assert.ok(app.db.notifications.some((n) => n.userId === dev.id && /15 minutes/.test(n.text))); assert.equal(app.db.events[0].status, 'hacking');
    app.tick(deadline - 5 * 60000); assert.equal(app.db.notifications.filter((n) => /15 minutes/.test(n.text) && n.userId === dev.id).length, 1, 'warned once');
    assert.equal((await dev.call('PUT', `/api/projects/${team.workspaceId}/files`, { path: 'last.js', content: 'ok' })).status, 200);
    app.tick(deadline + 1);
    assert.equal(app.db.events[0].status, 'judging'); assert.ok(app.db.projects.find((p) => p.id === team.workspaceId).frozen); assert.ok(app.db.snapshots[team.workspaceId].files['last.js']);
    assert.equal((await dev.call('PUT', `/api/projects/${team.workspaceId}/files`, { path: 'late.js', content: 'no' })).status, 403);
    assert.ok(app.db.audit.some((a) => a.action === 'event.auto_deadline')); assert.ok(app.db.notifications.some((n) => /deadline has passed/.test(n.text)));
    app.tick(deadline + 99999); assert.equal(app.db.events[0].status, 'judging');
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('automatic backups are written and a corrupted state file recovers from the newest backup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hc-ops-')); const stateFile = join(dir, 's.json');
  try {
    let app = await boot(stateFile, { autoBackupMinutes: 1, backupKeep: 3 }); await person(app, 'Keep Me', 'keep@x.io'); app.save(); const first = app.backupNow(); assert.ok(first);
    for (let i = 0; i < 4; i++) { await new Promise((r) => setTimeout(r, 5)); app.backupNow(); }
    assert.equal(readdirSync(join(dir, 'backups')).length, 3, 'old backups pruned'); await app.close();
    writeFileSync(stateFile, '{"projects": [ this is not json'); // simulate a crash mid-write / disk damage
    app = await boot(stateFile); assert.ok(app.db.users.some((u) => u.email === 'keep@x.io'), 'recovered users from backup'); assert.ok(readdirSync(dir).some((f) => f.includes('.corrupt-')), 'damaged file kept for inspection'); await app.close();
    rmSync(join(dir, 'backups'), { recursive: true }); writeFileSync(stateFile, 'garbage');
    assert.throws(() => createApp({ root, stateFile, autoBackupMinutes: 0 }), /unreadable and no valid backup/); assert.equal(existsSync(stateFile), true, 'never overwritten');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('account lockout survives a restart and clears on success', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hc-ops-')); const stateFile = join(dir, 's.json'); let app = await boot(stateFile);
  const login = (a, password) => fetch(`${a.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect' }, body: JSON.stringify({ email: 'lock@x.io', password }) }).then((r) => r.status);
  try {
    await person(app, 'Lock Me', 'lock@x.io');
    for (let i = 0; i < 4; i++) assert.equal(await login(app, 'wrong-password-123'), 401); assert.equal(await login(app, 'correct-horse-battery'), 200, 'success resets the counter');
    for (let i = 0; i < 5; i++) assert.equal(await login(app, 'wrong-password-123'), 401);
    assert.equal(await login(app, 'correct-horse-battery'), 429, 'locked even with the right password'); await app.close();
    app = await boot(stateFile); assert.equal(await login(app, 'correct-horse-battery'), 429, 'lock persisted across restart');
    app.db.users[0].lock.until = Date.now() - 1; assert.equal(await login(app, 'correct-horse-battery'), 200); assert.equal(app.db.users[0].lock, undefined);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
