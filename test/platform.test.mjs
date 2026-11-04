import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../lib/app.mjs';
import { scanSecrets, compileIgnore, isSensitivePath, isAlwaysSkipped } from '../lib/secrets.mjs';
import { buildDockerArgs } from '../lib/runner.mjs';
import { lineDiff, livekitToken } from '../lib/platform.mjs';
import { BridgeSync } from '../bridge/sync.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
let app, base, dir; const fakeRunner = { calls: [], async run(job) { this.calls.push(job); return { exitCode: 0, stdout: 'ran', stderr: '', timedOut: false }; } };
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hc-plat-'));
  app = createApp({ root, stateFile: join(dir, 'state.json'), authLimit: 1000, runner: fakeRunner });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(30); } throw new Error(`timed out: ${fn}`); };
const person = async (name, email) => {
  let cookie = '';
  const call = async (method, path, body, headers = {}) => { const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), 'x-requested-with': 'hackconnect', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }); const set = res.headers.get('set-cookie'); if (set && /hc_session=[^;]+/.test(set)) cookie = set.split(';')[0]; return { status: res.status, body: await res.json().catch(() => ({})) }; };
  const r = await call('POST', '/api/auth/signup', { name, email, password: 'correct-horse-battery' }); assert.equal(r.status, 201); return { call, id: r.body.user.id, get cookie() { return cookie; } };
};
const bearer = async (token, method, path, body) => { const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, body: await res.json().catch(() => ({})) }; };
const deviceLogin = async (p) => { const s = await (await fetch(`${base}/api/device/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json(); assert.equal((await (await fetch(`${base}/api/device/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceCode: s.deviceCode }) })).status), 202); assert.equal((await p.call('POST', '/api/device/approve', { userCode: s.userCode })).status, 200); const t = await (await fetch(`${base}/api/device/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceCode: s.deviceCode }) })).json(); assert.match(t.token, /^hc_/); return t.token; };
const mcp = (token, method, params, id = 1) => bearer(token, 'POST', '/mcp', { jsonrpc: '2.0', id, method, params });
const hist = (id) => app.db.history[id] || [];

test('secrets scanner, sensitive paths and ignore rules', () => {
  assert.deepEqual(scanSecrets('const a = 1'), []); assert.ok(scanSecrets('key = AKIAABCDEFGHIJKLMNOP').includes('AWS access key')); assert.ok(scanSecrets('-----BEGIN RSA PRIVATE KEY-----').length);
  assert.ok(scanSecrets('token: ghp_' + 'a'.repeat(36)).includes('GitHub token'));
  for (const p of ['.env', '.env.local', 'a/.env.production', 'id_rsa', 'certs/server.pem', 'credentials.json']) assert.ok(isSensitivePath(p), p);
  for (const p of ['src/env.js', 'README.md', 'environment.ts']) assert.ok(!isSensitivePath(p), p);
  assert.ok(isAlwaysSkipped('node_modules/x/y.js')); assert.ok(isAlwaysSkipped('a/.git/config')); assert.ok(!isAlwaysSkipped('src/app.js'));
  const ig = compileIgnore('# c\n*.log\n/build/\ntmp/\n!keep.log\ndocs/**/*.draft\n');
  assert.ok(ig('a.log')); assert.ok(ig('x/y/a.log')); assert.ok(!ig('keep.log')); assert.ok(ig('build/out.js')); assert.ok(!ig('src/build/out.js')); assert.ok(ig('src/tmp/z')); assert.ok(ig('docs/a/b/c.draft')); assert.ok(!ig('src/app.js'));
});

test('docker sandbox argv is locked down', () => {
  const args = buildDockerArgs({ name: 'n', dir: '/d', command: 'npm test', runtime: 'runsc' }); const s = args.join(' ');
  for (const must of ['--network none', '--read-only', '--cap-drop ALL', 'no-new-privileges', '--pids-limit', '--memory 256m', '--runtime runsc', '--user 1000:1000']) assert.ok(s.includes(must), must);
  assert.ok(!s.includes('docker.sock')); assert.ok(!s.includes('--privileged')); assert.ok(buildDockerArgs({ name: 'n', dir: '/d', command: 'x', network: true }).includes('bridge'));
});

test('line diff and livekit token', () => {
  assert.deepEqual(lineDiff('a\nb', 'a\nc').map((d) => d.t), [' ', '-', '+']);
  const [h, b, sig] = livekitToken({ key: 'k', secret: 's', room: 'r', identity: 'u', name: 'U', canPublish: true }).split('.');
  assert.equal(sig, crypto.createHmac('sha256', 's').update(`${h}.${b}`).digest('base64url')); assert.equal(JSON.parse(Buffer.from(b, 'base64url')).video.room, 'r');
});

test('device login, bearer scope, and CSRF exemption only for bearer', async () => {
  const u = await person('Dee Vice', 'dee@x.io'); const token = await deviceLogin(u);
  assert.equal((await bearer(token, 'GET', '/api/auth/me')).body.user.email, 'dee@x.io');
  assert.equal((await bearer(token, 'GET', '/api/events')).status, 403); assert.equal((await bearer(token, 'POST', '/api/teams', { name: 'x' })).status, 403);
  assert.equal((await bearer(token, 'DELETE', '/api/me', { password: 'correct-horse-battery' })).status, 403);
  assert.equal((await bearer(token, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401); // bridge tokens are not MCP tokens
  assert.equal((await bearer('hc_bogus', 'GET', '/api/auth/me')).status, 401);
  const noHeader = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: u.cookie }, body: JSON.stringify({ name: 'csrf' }) }); assert.equal(noHeader.status, 403);
  assert.equal((await u.call('POST', '/api/device/approve', { userCode: 'NOPE-NOPE' })).status, 404);
});

test('Local Bridge: ignore rules, secrets, CRLF, loop prevention, conflicts, deletes, traversal, attribution', async () => {
  const owner = await person('Bri Dge', 'bridge@x.io'); const mate = await person('Team Mate', 'mate@x.io'); const token = await deviceLogin(owner);
  const ws = (await owner.call('POST', '/api/projects', { name: 'Bridge Room' })).body.id;
  const inv = await owner.call('POST', `/api/projects/${ws}/invites`, { role: 'editor' }); await mate.call('POST', `/api/invites/${inv.body.token}/accept`, {});
  const local = mkdtempSync(join(tmpdir(), 'hc-local-')); mkdirSync(join(local, 'src')); mkdirSync(join(local, 'node_modules/x'), { recursive: true });
  writeFileSync(join(local, '.gitignore'), 'ignored.txt\n'); writeFileSync(join(local, 'ignored.txt'), 'nope'); writeFileSync(join(local, '.env'), 'API=1'); writeFileSync(join(local, 'node_modules/x/i.js'), 'nm');
  writeFileSync(join(local, 'leaky.js'), 'const k = "AKIAABCDEFGHIJKLMNOP";'); writeFileSync(join(local, 'src/a.js'), 'line1\r\nline2\r\n'); writeFileSync(join(local, 'bin.dat'), Buffer.from([1, 0, 2]));
  const logs = []; const sync = new BridgeSync({ dir: local, server: base, token, workspaceId: ws, log: (m) => logs.push(m), debounceMs: 30 }); sync.start();
  await until(() => sync.synced); await until(() => app.db.projects.find((p) => p.id === ws).files['src/a.js'] !== undefined);
  const files = () => app.db.projects.find((p) => p.id === ws).files;
  assert.equal(files()['src/a.js'], 'line1\nline2\n', 'CRLF normalised in the shared doc');
  for (const bad of ['.env', 'ignored.txt', 'node_modules/x/i.js', 'leaky.js', 'bin.dat']) assert.equal(files()[bad], undefined, `${bad} must not be uploaded`);
  assert.ok(logs.some((l) => l.includes('.env')) && logs.some((l) => l.includes('leaky.js')));
  // local -> remote, and CRLF preserved when remote edits flow back
  writeFileSync(join(local, 'src/a.js'), 'line1\r\nline2\r\nline3\r\n'); await until(() => files()['src/a.js'] === 'line1\nline2\nline3\n');
  assert.equal((await mate.call('PUT', `/api/projects/${ws}/files`, { path: 'src/a.js', content: 'line1\nline2\nline3\nfromMate\n' })).status, 200);
  await until(() => readFileSync(join(local, 'src/a.js'), 'utf8') === 'line1\r\nline2\r\nline3\r\nfromMate\r\n'); // remote -> local, EOL style kept
  assert.equal((await mate.call('PUT', `/api/projects/${ws}/files`, { path: 'new/dir/b.txt', content: 'hello' })).status, 200); await until(() => existsSync(join(local, 'new/dir/b.txt')));
  // loop prevention: our own writes must not create extra history echoes
  await sleep(400); const before = hist(ws).length; await sleep(500); assert.equal(hist(ws).length, before);
  // delete propagates both ways
  rmSync(join(local, 'new/dir/b.txt')); await until(() => files()['new/dir/b.txt'] === undefined);
  // a hostile teammate plants a path-traversal key in the document; the bridge must refuse it
  const { default: Y } = { default: await import('yjs') }; const peer = new Y.Doc(); const { WebSocket } = await import('ws');
  const peerSync = new BridgeSync({ dir: mkdtempSync(join(tmpdir(), 'hc-peer-')), server: base, token: await deviceLogin(mate), workspaceId: ws, log: () => {} }); peerSync.start(); await until(() => peerSync.synced);
  peerSync.doc.transact(() => { peerSync.files.set('../evil.txt', new Y.Text('pwned')); peerSync.files.set('/abs-evil.txt', new Y.Text('pwned')); }, 'test'); await sleep(500);
  assert.ok(!existsSync(join(local, '..', 'evil.txt'))); assert.ok(!existsSync('/abs-evil.txt')); assert.ok(logs.some((l) => l.includes('unsafe remote path')));
  peerSync.stop(); sync.stop(); peer.destroy(); void WebSocket;
  // conflict on re-share: both changed -> local kept as backup, never silently overwritten
  writeFileSync(join(local, 'src/a.js'), 'LOCAL VERSION\n'); await mate.call('PUT', `/api/projects/${ws}/files`, { path: 'src/a.js', content: 'REMOTE VERSION\n' });
  const logs2 = []; const again = new BridgeSync({ dir: local, server: base, token, workspaceId: ws, log: (m) => logs2.push(m), debounceMs: 30 }); again.start(); await until(() => again.synced);
  await until(() => readFileSync(join(local, 'src/a.js'), 'utf8').includes('REMOTE VERSION')); assert.equal(readFileSync(join(local, 'src/a.js.hc-local-backup'), 'utf8'), 'LOCAL VERSION\n'); assert.ok(logs2.some((l) => l.includes('CONFLICT')));
  again.stop();
  // attribution: a session tagged as an agent produces agent_edit history
  const agentSync = new BridgeSync({ dir: local, server: base, token, workspaceId: ws, agent: 'claude-code', log: () => {}, debounceMs: 30 }); agentSync.start(); await until(() => agentSync.synced);
  writeFileSync(join(local, 'agent.js'), 'export const made = "by an agent";\n'); await until(() => files()['agent.js']); await until(() => hist(ws).some((h) => h.path === 'agent.js'));
  const entry = hist(ws).filter((h) => h.path === 'agent.js').pop(); assert.equal(entry.kind, 'agent_edit'); assert.match(entry.actor, /claude-code/);
  agentSync.stop(); rmSync(local, { recursive: true, force: true });
});

test('MCP: scoped tokens, approval gate, read-only tokens, revocation, event policy', async () => {
  const owner = await person('Em Cee', 'mcp@x.io'); const ws = (await owner.call('POST', '/api/projects', { name: 'MCP Room' })).body.id;
  const edTok = (await owner.call('POST', `/api/projects/${ws}/tokens`, { role: 'editor', label: 'Claude Code' })).body; const roTok = (await owner.call('POST', `/api/projects/${ws}/tokens`, { role: 'viewer', label: 'Reader' })).body;
  const stranger = await person('No Access', 'noacc@x.io'); assert.equal((await stranger.call('POST', `/api/projects/${ws}/tokens`, { role: 'editor' })).status, 404);
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: owner.cookie }, body: '{}' })).status, 401); // cookies are not accepted on /mcp
  assert.equal((await mcp(edTok.token, 'initialize', {})).body.result.serverInfo.name, 'hackconnect');
  assert.deepEqual((await mcp(edTok.token, 'tools/list')).body.result.tools.map((t) => t.name), ['list_files', 'read_file', 'write_file', 'replace_in_file']);
  const text = (r) => r.body.result.content[0].text;
  assert.match(text(await mcp(edTok.token, 'tools/call', { name: 'list_files', arguments: {} })), /README\.md/);
  assert.equal(text(await mcp(edTok.token, 'tools/call', { name: 'read_file', arguments: { path: '../../etc/passwd' } })), 'A safe relative path is required.');
  // default = ask: write becomes a proposal, file untouched until a human approves
  const w = await mcp(edTok.token, 'tools/call', { name: 'write_file', arguments: { path: 'agent.txt', content: 'v1' } }); assert.match(text(w), /Proposed/);
  const file = () => app.db.projects.find((p) => p.id === ws).files['agent.txt']; assert.equal(file(), undefined);
  const props = (await owner.call('GET', `/api/projects/${ws}/proposals`)).body.proposals; assert.equal(props.length, 1); assert.ok(props[0].diff.some((d) => d.t === '+' && d.s === 'v1'));
  assert.equal((await owner.call('POST', `/api/projects/${ws}/proposals/${props[0].id}/approve`, {})).status, 200); assert.equal(file(), 'v1');
  const h = hist(ws).filter((x) => x.path === 'agent.txt').pop(); assert.equal(h.kind, 'agent_edit'); assert.match(h.actor, /Claude Code \(MCP, for Em Cee\)/);
  // reject path, stale proposal
  await mcp(edTok.token, 'tools/call', { name: 'write_file', arguments: { path: 'agent.txt', content: 'v2' } });
  const p2 = (await owner.call('GET', `/api/projects/${ws}/proposals`)).body.proposals[0]; await owner.call('PUT', `/api/projects/${ws}/files`, { path: 'agent.txt', content: 'human-edit' });
  assert.equal((await owner.call('POST', `/api/projects/${ws}/proposals/${p2.id}/approve`, {})).status, 409);
  await mcp(edTok.token, 'tools/call', { name: 'write_file', arguments: { path: 'agent.txt', content: 'v3' } }); const p3 = (await owner.call('GET', `/api/projects/${ws}/proposals`)).body.proposals[0]; assert.equal((await owner.call('POST', `/api/projects/${ws}/proposals/${p3.id}/reject`, {})).status, 200); assert.equal(file(), 'human-edit');
  // auto mode applies directly (and replace_in_file requires a unique match)
  assert.equal((await owner.call('PATCH', `/api/projects/${ws}`, { agentApproval: 'auto' })).body.agentApproval, 'auto');
  assert.match(text(await mcp(edTok.token, 'tools/call', { name: 'replace_in_file', arguments: { path: 'agent.txt', old_text: 'human', new_text: 'agent' } })), /Wrote/); assert.equal(file(), 'agent-edit');
  assert.match(text(await mcp(edTok.token, 'tools/call', { name: 'replace_in_file', arguments: { path: 'agent.txt', old_text: 'zzz', new_text: 'x' } })), /matched 0/);
  assert.match(text(await mcp(edTok.token, 'tools/call', { name: 'write_file', arguments: { path: '.env', content: 'A=1' } })), /sensitive/);
  // read-only token can read but never write
  assert.equal(text(await mcp(roTok.token, 'tools/call', { name: 'read_file', arguments: { path: 'agent.txt' } })), 'agent-edit');
  assert.match(text(await mcp(roTok.token, 'tools/call', { name: 'write_file', arguments: { path: 'x.txt', content: 'x' } })), /read-only/);
  // a token is bound to its workspace; revoke kills it; removing the user's access kills writes
  assert.equal((await owner.call('GET', `/api/projects/${ws}/tokens`)).body.tokens.length, 2);
  assert.equal((await owner.call('DELETE', `/api/projects/${ws}/tokens/${edTok.id}`)).status, 200); assert.equal((await mcp(edTok.token, 'ping')).status, 401);
  // event "no agents" policy blocks MCP + built-in agent in event workspaces
  const org = await person('Eve Org', 'eveorg@x.io'); const part = await person('Pat Ici', 'patici@x.io');
  const ev = (await org.call('POST', '/api/events', { title: 'No Bots', agentPolicy: 'none' })).body; await org.call('PATCH', `/api/events/${ev.id}`, { status: 'registration' }); await part.call('POST', `/api/events/${ev.id}/register`, {});
  const team = (await part.call('POST', `/api/events/${ev.id}/teams`, { name: 'Humans' })).body; const tok = (await part.call('POST', `/api/projects/${team.workspaceId}/tokens`, { role: 'editor' })).body.token;
  assert.match(text(await mcp(tok, 'tools/call', { name: 'list_files', arguments: {} })), /does not allow agents/); assert.equal((await part.call('POST', `/api/projects/${team.workspaceId}/agent`, { prompt: 'hi' })).status, 403);
});

test('built-in agent obeys the approval gate', async () => {
  const u = await person('Ag Ent', 'agent@x.io'); const ws = (await u.call('POST', '/api/projects', { name: 'Agent Room' })).body.id;
  await u.call('PUT', `/api/projects/${ws}/files`, { path: 'dashboard.tsx', content: 'export function Dashboard() {\n  return (\n    <main><ActivityFeed projectId={project.id} /></main>\n  )\n}\n' });
  const r = await u.call('POST', `/api/projects/${ws}/agent`, { prompt: 'add an empty state' }); assert.equal(r.status, 200); assert.equal(r.body.changes.length, 0); assert.equal(r.body.proposals.length, 1);
  assert.ok(!app.db.projects.find((p) => p.id === ws).files['dashboard.tsx'].includes('hasActivity'));
  await u.call('POST', `/api/projects/${ws}/proposals/${r.body.proposals[0].id}/approve`, {}); assert.ok(app.db.projects.find((p) => p.id === ws).files['dashboard.tsx'].includes('hasActivity'));
});

test('secrets in REST writes: sensitive files refused, leaks warned', async () => {
  const u = await person('Sec Ret', 'secret@x.io'); const ws = (await u.call('POST', '/api/projects', { name: 'Sec Room' })).body.id;
  assert.equal((await u.call('PUT', `/api/projects/${ws}/files`, { path: '.env', content: 'A=1' })).status, 422);
  const r = await u.call('PUT', `/api/projects/${ws}/files`, { path: 'cfg.js', content: 'const k="AKIAABCDEFGHIJKLMNOP"' }); assert.equal(r.status, 200); assert.match(r.body.warnings[0], /AWS access key/);
});

test('tunnels are private by default; run needs runner; LiveKit degrades', async () => {
  const u = await person('Tun Nel', 'tunnel@x.io'); const other = await person('Out Sider', 'outsider2@x.io'); const ws = (await u.call('POST', '/api/projects', { name: 'Tunnel Room' })).body.id;
  assert.equal((await u.call('POST', `/api/projects/${ws}/tunnels`, { port: 3000, url: 'http://insecure.example' })).status, 400);
  const t = await u.call('POST', `/api/projects/${ws}/tunnels`, { port: 3000, url: 'https://abc-def.trycloudflare.com/path' }); assert.equal(t.status, 201); assert.equal(t.body.visibility, 'private'); assert.equal(t.body.url, 'https://abc-def.trycloudflare.com');
  assert.equal((await other.call('GET', `/api/projects/${ws}/tunnels`)).status, 404); assert.equal((await u.call('GET', `/api/projects/${ws}/tunnels`)).body.tunnels.length, 1);
  assert.equal((await u.call('DELETE', `/api/projects/${ws}/tunnels/${t.body.id}`)).status, 200); assert.equal((await u.call('GET', `/api/projects/${ws}/tunnels`)).body.tunnels.length, 0);
  const run = await u.call('POST', `/api/projects/${ws}/run`, { command: 'node -v' }); assert.equal(run.body.stdout, 'ran'); assert.equal(fakeRunner.calls.at(-1).network, false); assert.equal((await other.call('POST', `/api/projects/${ws}/run`, { command: 'id' })).status, 404);
  const lk = await u.call('POST', `/api/projects/${ws}/call-token`, {}); assert.equal(lk.status, 503); assert.equal(lk.body.fallback, 'p2p');
  Object.assign(process.env, { LIVEKIT_URL: 'wss://lk.example', LIVEKIT_API_KEY: 'key', LIVEKIT_API_SECRET: 'secret' }); try { const ok = await u.call('POST', `/api/projects/${ws}/call-token`, {}); assert.equal(ok.status, 200); assert.equal(ok.body.url, 'wss://lk.example'); } finally { delete process.env.LIVEKIT_URL; delete process.env.LIVEKIT_API_KEY; delete process.env.LIVEKIT_API_SECRET; }
});

test('admin console, kill switch, suspension, quotas, reports', async () => {
  const admin = app.db.users.find((x) => x.role === 'admin'); assert.ok(admin);
  const a = await person('Reg Ular', 'regular@x.io'); assert.equal((await a.call('GET', '/api/admin/overview')).status, 403);
  // sign in as the first (admin) account
  const adminRes = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect' }, body: JSON.stringify({ email: admin.email, password: 'correct-horse-battery' }) }); const adminCookie = adminRes.headers.get('set-cookie').split(';')[0];
  const adm = async (method, path, body) => { const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect', cookie: adminCookie }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
  assert.ok((await adm('GET', '/api/admin/overview')).body.users > 5);
  assert.equal((await a.call('POST', '/api/reports', { targetType: 'workspace', targetId: 'x', reason: 'abuse' })).status, 201); assert.equal((await adm('GET', '/api/admin/reports')).body.reports.length >= 1, true);
  // quota
  const q = await person('Quo Ta', 'quota@x.io'); for (let i = 0; i < 10; i++) assert.equal((await q.call('POST', '/api/projects', { name: `w${i}` })).status, 201); assert.equal((await q.call('POST', '/api/projects', { name: 'one-too-many' })).status, 402);
  assert.equal((await adm('POST', `/api/admin/users/${q.id}`, { plan: 'pro' })).status, 200); assert.equal((await q.call('POST', '/api/projects', { name: 'now-ok' })).status, 201); assert.equal((await q.call('GET', '/api/me/usage')).body.plan, 'pro');
  // kill switch stops agents, runs and tunnels
  const ws = (await a.call('POST', '/api/projects', { name: 'Kill Room' })).body.id; await adm('POST', '/api/admin/kill-switch', { enabled: true });
  assert.equal((await a.call('POST', `/api/projects/${ws}/agent`, { prompt: 'x' })).status, 503); assert.equal((await a.call('POST', `/api/projects/${ws}/run`, { command: 'x' })).status, 503); await adm('POST', '/api/admin/kill-switch', { enabled: false });
  // suspension revokes access immediately
  assert.equal((await a.call('GET', '/api/auth/me')).status, 200); await adm('POST', `/api/admin/users/${a.id}`, { suspended: true }); assert.equal((await a.call('GET', '/api/auth/me')).status, 401);
  assert.equal((await adm('POST', `/api/admin/users/${admin.id}`, { suspended: true })).status, 400);
});

test('account export and deletion', async () => {
  const u = await person('Del Ete', 'delete@x.io'); const mate = await person('Stay Put', 'stay@x.io'); const ws = (await u.call('POST', '/api/projects', { name: 'Shared Room' })).body.id;
  const inv = await u.call('POST', `/api/projects/${ws}/invites`, { role: 'editor' }); await mate.call('POST', `/api/invites/${inv.body.token}/accept`, {});
  const solo = (await u.call('POST', '/api/projects', { name: 'Solo Room' })).body.id; await u.call('POST', `/api/projects/${ws}/messages`, { text: 'hello' });
  const exp = await u.call('GET', '/api/me/export'); assert.equal(exp.body.profile.email, 'delete@x.io'); assert.ok(exp.body.workspaces.some((w) => w.id === solo)); assert.equal(exp.body.profile.passwordHash, undefined);
  assert.equal((await u.call('DELETE', '/api/me', { password: 'wrong-password-123' })).status, 401); assert.equal((await u.call('DELETE', '/api/me', { password: 'correct-horse-battery' })).status, 200);
  assert.equal((await u.call('GET', '/api/auth/me')).status, 401); assert.ok(!app.db.users.some((x) => x.email === 'delete@x.io')); assert.ok(!app.db.projects.some((p) => p.id === solo));
  const shared = app.db.projects.find((p) => p.id === ws); assert.equal(shared.members[mate.id], 'owner'); assert.equal(app.db.messages[ws].find((m) => m.text === 'hello').user, 'Deleted user');
});
