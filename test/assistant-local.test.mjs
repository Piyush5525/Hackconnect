import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../lib/app.mjs';
import { startAgentBridge } from '../bridge/agent-bridge.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const boot = async (stateFile) => { const app = createApp({ root, stateFile, authLimit: 1e6, autoBackupMinutes: 0 }); await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); app.base = `http://127.0.0.1:${app.server.address().port}`; return app; };
const person = async (app, name, email) => { let cookie = ''; const call = async (method, path, body) => { const res = await fetch(app.base + path, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]; return { status: res.status, body: await res.json().catch(() => ({})) }; }; await call('POST', '/api/auth/signup', { name, email, password: 'correct-horse-battery' }); return { call }; };

test('sign-in providers (Claude / Codex on the user\'s computer): prepare a prompt, then turn the local answer into a proposal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hc-local-')); const app = await boot(join(dir, 's.json'));
  try {
    const u = await person(app, 'Loc U', 'locu@x.io'); const ws = (await u.call('POST', '/api/projects', { name: 'Local Room' })).body.id;
    assert.equal((await u.call('PUT', '/api/me/ai', { provider: 'local-claude' })).status, 200);
    const view = (await u.call('GET', '/api/me/ai')).body; assert.equal(view.provider, 'local-claude'); assert.equal(view.hasKey, false); assert.ok(view.presets.some((p) => p.id === 'local-codex' && p.local === 'codex'));
    const prep = await u.call('POST', `/api/projects/${ws}/agent`, { prompt: 'explain', prepare: true }); assert.equal(prep.status, 200); assert.match(prep.body.prompt, /coding assistant/); assert.match(prep.body.prompt, /"request":"explain"/);
    const answer = JSON.stringify({ message: 'Added a note.', changes: [{ path: 'note.txt', content: 'hello' }] });
    const done = await u.call('POST', `/api/projects/${ws}/agent`, { prompt: 'add a note', localText: answer, localTool: 'claude' }); assert.equal(done.status, 200); assert.equal(done.body.provider, 'Claude'); assert.equal(done.body.message, 'Added a note.');
    assert.ok(done.body.proposals.length === 1 || done.body.changes.length === 1, 'the change is either waiting for approval or applied');
    // a provider that needs the local bridge never calls out from the server
    const direct = await u.call('POST', `/api/projects/${ws}/agent`, { prompt: 'hi' }); assert.equal(direct.status, 502); assert.match(direct.body.error, /your own computer/);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('assistant bridge only answers the allowed website and a localhost host', async () => {
  const port = 47900 + Math.floor(Math.random() * 50); const server = await startAgentBridge({ origins: ['http://hc.example'], port, log: () => {} });
  try {
    const get = (headers) => fetch(`http://127.0.0.1:${port}/status`, { headers }); // fetch will not let us fake Host, so Origin is what we can vary
    assert.equal((await get({})).status, 403, 'no Origin header (not a browser page)'); assert.equal((await get({ origin: 'https://evil.example' })).status, 403);
    const ok = await get({ origin: 'http://hc.example' }); assert.equal(ok.status, 200); assert.equal(ok.headers.get('access-control-allow-origin'), 'http://hc.example'); const body = await ok.json(); assert.ok('claude' in body.tools && 'codex' in body.tools);
    const bad = await fetch(`http://127.0.0.1:${port}/run`, { method: 'POST', headers: { origin: 'http://hc.example', 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'rm', prompt: 'x' }) }); assert.equal(bad.status, 400);
    const pre = await fetch(`http://127.0.0.1:${port}/run`, { method: 'OPTIONS', headers: { origin: 'http://hc.example', 'access-control-request-method': 'POST' } }); assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-private-network'), 'true');
  } finally { await new Promise((r) => server.close(r)); }
});

test('deadline reminders come in stages (3 days, 24 hours, 3 hours, 1 hour) without repeating', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hc-stages-')); const app = await boot(join(dir, 's.json'));
  try {
    const org = await person(app, 'Org S', 'orgs@x.io'); const dev = await person(app, 'Dev S', 'devs@x.io');
    const ev = (await org.call('POST', '/api/events', { title: 'Stage Hack', agentPolicy: 'allowed' })).body; await org.call('PATCH', `/api/events/${ev.id}`, { status: 'registration' }); await dev.call('POST', `/api/events/${ev.id}/register`, {}); await dev.call('POST', `/api/events/${ev.id}/teams`, { name: 'T' }); await org.call('PATCH', `/api/events/${ev.id}`, { status: 'hacking' });
    const deadline = Date.now() + 10 * 86400e3; await org.call('PATCH', `/api/events/${ev.id}`, { deadline });
    const count = (re) => app.db.notifications.filter((n) => re.test(n.text)).length;
    app.tick(deadline - 5 * 86400e3); assert.equal(count(/until the deadline/), 0, 'five days out: nothing yet');
    app.tick(deadline - 2 * 86400e3); const after3d = count(/3 days until/); assert.ok(after3d >= 1); app.tick(deadline - 2 * 86400e3 + 1000); assert.equal(count(/3 days until/), after3d, 'not repeated');
    app.tick(deadline - 20 * 3600e3); assert.ok(count(/24 hours until/) >= 1); app.tick(deadline - 2 * 3600e3); assert.ok(count(/3 hours until/) >= 1); app.tick(deadline - 50 * 60e3); assert.ok(count(/1 hour until/) >= 1);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('assistant launcher zip: double-click scripts with this server baked in, bridge included, tool-specific install offer', async () => {
  const { unzipSync, strFromU8 } = await import('fflate'); const dir = mkdtempSync(join(tmpdir(), 'hc-launch-')); const app = await boot(join(dir, 's.json'));
  try {
    const res = await fetch(`${app.base}/download/hackconnect-assistant.zip?tool=codex`); assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'application/zip');
    const z = unzipSync(new Uint8Array(await res.arrayBuffer())); assert.deepEqual(Object.keys(z).sort(), ['README.txt', 'agent-bridge.mjs', 'start-assistant.cmd', 'start-assistant.command', 'start-assistant.sh']);
    const cmd = strFromU8(z['start-assistant.cmd']); assert.ok(cmd.includes(`--origin ${app.base}`)); assert.ok(cmd.includes('@openai/codex')); assert.ok(!cmd.includes('anthropic')); assert.ok(cmd.includes('\r\n'), 'Windows line endings');
    assert.match(strFromU8(z['start-assistant.sh']), /^#!\/bin\/sh/);
    assert.ok(strFromU8((await (async () => unzipSync(new Uint8Array(await (await fetch(`${app.base}/download/hackconnect-assistant.zip?tool=evil%22%26calc`)).arrayBuffer())))())['start-assistant.cmd']).includes('@anthropic-ai/claude-code'), 'unknown tool falls back to Claude; input never reaches the script');
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
