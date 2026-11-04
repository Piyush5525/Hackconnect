import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../lib/app.mjs';
import { assertSafeAiUrl } from '../lib/agent.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
let app, base, dir, model, modelBase; const seen = []; let mode = 'json';
before(async () => {
  model = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c; const parsed = body ? JSON.parse(body) : {}; seen.push({ url: req.url, auth: req.headers.authorization, body: parsed });
    if (mode === '401') { res.writeHead(401); return res.end('{}'); } if (mode === '404') { res.writeHead(404); return res.end('{}'); }
    const content = mode === 'text' ? 'Just a plain answer, no JSON.' : JSON.stringify({ message: 'I added a **greeting** file.', changes: [{ path: 'hello.js', content: 'console.log("hello")\n' }, { path: '../escape.js', content: 'x' }] });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((r) => model.listen(0, '127.0.0.1', r)); modelBase = `http://127.0.0.1:${model.address().port}/v1`;
  dir = mkdtempSync(join(tmpdir(), 'hc-ai-')); app = createApp({ root, stateFile: join(dir, 's.json'), authLimit: 1e6, autoBackupMinutes: 0 }); await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => { await app.close(); model.closeAllConnections?.(); await new Promise((r) => model.close(r)); rmSync(dir, { recursive: true, force: true }); });

const person = async (name, email) => { let cookie = ''; const call = async (method, path, body) => { const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const set = res.headers.get('set-cookie'); if (set && /hc_session/.test(set)) cookie = set.split(';')[0]; return { status: res.status, body: await res.json().catch(() => ({})) }; }; const r = await call('POST', '/api/auth/signup', { name, email, password: 'correct-horse-battery' }); return { call, id: r.body.user.id }; };

test('SSRF guard on user-supplied AI endpoints', async () => {
  await assert.rejects(assertSafeAiUrl('http://169.254.169.254/latest', true), /link-local|metadata/); await assert.rejects(assertSafeAiUrl('http://[fe80::1]/', true), /link-local/); await assert.rejects(assertSafeAiUrl('ftp://example.com', true), /http/); await assert.rejects(assertSafeAiUrl('http://user:pw@example.com/', true), /username/); await assert.rejects(assertSafeAiUrl('not a url', true), /valid/);
  await assert.rejects(assertSafeAiUrl('http://localhost:11434/v1', false), /public AI endpoints/); await assert.rejects(assertSafeAiUrl('http://10.0.0.5/v1', false), /public/); await assert.rejects(assertSafeAiUrl('http://192.168.1.9/v1', false), /public/); await assert.rejects(assertSafeAiUrl('http://[::1]:11434/', false), /public/); await assert.rejects(assertSafeAiUrl('http://[::ffff:127.0.0.1]/', false), /public/);
  assert.ok(await assertSafeAiUrl('http://localhost:11434/v1', true)); assert.ok(await assertSafeAiUrl('http://127.0.0.1:1234', true)); await assert.rejects(assertSafeAiUrl('http://localhost/', true).then(() => assertSafeAiUrl('http://169.254.1.1', true)), /metadata/);
});

test('AI settings: validation, encrypted key storage, key never returned', async () => {
  const u = await person('Ai Owner', 'ai@x.io'); const secret = 'sk-test-' + 'q'.repeat(30);
  const initial = (await u.call('GET', '/api/me/ai')).body; assert.equal(initial.provider, ''); assert.equal(initial.hasKey, false); assert.ok(initial.presets.some((p) => p.id === 'ollama' && p.baseUrl.includes('11434'))); assert.ok(initial.presets.some((p) => p.id === 'anthropic'));
  assert.equal((await u.call('PUT', '/api/me/ai', { provider: 'skynet' })).status, 400); assert.equal((await u.call('PUT', '/api/me/ai', { provider: 'groq' })).status, 400, 'groq needs a key');
  assert.equal((await u.call('PUT', '/api/me/ai', { provider: 'custom', baseUrl: 'http://169.254.169.254/v1' })).status, 400); assert.equal((await u.call('PUT', '/api/me/ai', { provider: 'groq', apiKey: 'has spaces in it' })).status, 400);
  const saved = await u.call('PUT', '/api/me/ai', { provider: 'groq', apiKey: secret }); assert.equal(saved.status, 200); assert.equal(saved.body.hasKey, true); assert.equal(saved.body.model, 'llama-3.3-70b-versatile'); assert.ok(!JSON.stringify(saved.body).includes(secret), 'key never echoed');
  assert.ok(!JSON.stringify((await u.call('GET', '/api/me/ai')).body).includes(secret)); assert.ok(!JSON.stringify((await u.call('GET', '/api/auth/me')).body).includes(secret)); assert.ok(!JSON.stringify((await u.call('GET', '/api/bootstrap')).body).includes(secret));
  app.saveNow(); const raw = readFileSync(join(dir, 's.json'), 'utf8'); assert.ok(!raw.includes(secret), 'not stored in plaintext'); assert.match(raw, /"keyEnc":"v1\./);
  assert.equal((await u.call('PUT', '/api/me/ai', { provider: 'groq', model: 'other-model' })).body.hasKey, true, 'existing key is kept when only the model changes'); assert.equal((await u.call('PUT', '/api/me/ai', { provider: 'groq', clearKey: true })).status, 400);
  assert.equal((await u.call('DELETE', '/api/me/ai')).body.provider, ''); assert.equal((await u.call('GET', '/api/me/ai')).body.hasKey, false);
  assert.equal((await fetch(`${base}/api/me/ai`)).status, 401);
});

test('assistant uses the signed-in user\'s own provider, key, history and focus file', async () => {
  const u = await person('Ai User', 'aiuser@x.io'); const other = await person('Other U', 'otheru@x.io'); const ws = (await u.call('POST', '/api/projects', { name: 'Ai Room' })).body.id;
  await u.call('PUT', `/api/projects/${ws}/files`, { path: 'main.js', content: 'console.log(1)\n' }); await u.call('PUT', '/api/me/ai', { provider: 'custom', baseUrl: modelBase, model: 'tiny', apiKey: 'user-key-123' });
  seen.length = 0; mode = 'json'; const r = await u.call('POST', `/api/projects/${ws}/agent`, { prompt: 'say hello', focus: 'main.js', history: [{ role: 'user', content: 'earlier question' }, { role: 'assistant', content: 'earlier answer' }, { role: 'system', content: 'ignored' }] });
  assert.equal(r.status, 200); assert.match(r.body.message, /greeting/); assert.equal(seen.length, 1); assert.equal(seen[0].auth, 'Bearer user-key-123'); assert.equal(seen[0].url, '/v1/chat/completions'); assert.equal(seen[0].body.model, 'tiny');
  const roles = seen[0].body.messages.map((m) => m.role); assert.deepEqual(roles, ['system', 'user', 'assistant', 'user'], 'system turns from the client are dropped'); assert.match(seen[0].body.messages.at(-1).content, /"openFile":"main.js"/);
  assert.equal(r.body.proposals.length, 1, 'edits wait for approval (path traversal change is dropped)'); assert.equal(r.body.changes.length, 0); assert.equal(app.db.projects.find((p) => p.id === ws).files['hello.js'], undefined);
  // a different user does not get this user's settings
  const ws2 = (await other.call('POST', '/api/projects', { name: 'Other Room' })).body.id; seen.length = 0; const demo = await other.call('POST', `/api/projects/${ws2}/agent`, { prompt: 'hello' }); assert.equal(demo.status, 200); assert.equal(seen.length, 0); assert.match(demo.body.message, /demo mode/i);
  // provider errors become helpful messages; plain-text answers still work
  mode = '401'; const bad = await u.call('POST', `/api/projects/${ws}/agent`, { prompt: 'x' }); assert.equal(bad.status, 502); assert.match(bad.body.error, /rejected the API key/); mode = '404'; assert.match((await u.call('POST', `/api/projects/${ws}/agent`, { prompt: 'x' })).body.error, /does not know the model "tiny"/);
  mode = 'text'; const plain = await u.call('POST', `/api/projects/${ws}/agent`, { prompt: 'explain' }); assert.equal(plain.status, 200); assert.equal(plain.body.message, 'Just a plain answer, no JSON.'); assert.equal(plain.body.changes.length, 0);
  // auto-apply workspace applies the change live
  await u.call('PATCH', `/api/projects/${ws}`, { agentApproval: 'auto' }); mode = 'json'; const auto = await u.call('POST', `/api/projects/${ws}/agent`, { prompt: 'make it' }); assert.equal(auto.body.changes.length, 1); assert.equal(app.db.projects.find((p) => p.id === ws).files['hello.js'], 'console.log("hello")\n');
});

test('assistant refuses private endpoints on a hosted server and is rate limited', async () => {
  const u = await person('Hosted H', 'hosted@x.io'); process.env.HACKCONNECT_ALLOW_PRIVATE_AI = 'false';
  try { assert.equal((await u.call('PUT', '/api/me/ai', { provider: 'ollama' })).status, 400); assert.equal((await u.call('PUT', '/api/me/ai', { provider: 'custom', baseUrl: modelBase })).status, 400); } finally { delete process.env.HACKCONNECT_ALLOW_PRIVATE_AI; }
  const ws = (await u.call('POST', '/api/projects', { name: 'Rate Room' })).body.id; let last; for (let i = 0; i < 22; i++) last = await u.call('POST', `/api/projects/${ws}/agent`, { prompt: `q${i}` }); assert.equal(last.status, 429);
});
