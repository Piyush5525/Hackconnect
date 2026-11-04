import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { parse } from 'yaml';
import { createApp } from '../lib/app.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (f) => readFileSync(join(root, f), 'utf8');

test('render.yaml: one web service, one instance, persistent disk on the data folder, health check, secure cookies', () => {
  const svc = parse(read('render.yaml')).services[0]; const env = Object.fromEntries(svc.envVars.map((e) => [e.key, e]));
  assert.equal(svc.type, 'web'); assert.equal(svc.runtime, 'docker'); assert.equal(svc.numInstances, 1, 'single instance: the state file belongs to one process'); assert.equal(svc.healthCheckPath, '/health');
  assert.notEqual(svc.plan, 'free', 'a persistent disk is not available on the free plan'); assert.equal(svc.disk.mountPath, '/app/.hackconnect');
  assert.equal(env.HACKCONNECT_SECURE_COOKIES.value, 'true'); assert.equal(env.HACKCONNECT_MASTER_KEY.generateValue, true); assert.ok(!('PORT' in env), 'Render provides PORT itself');
  for (const secret of ['SMTP_PASS', 'GITHUB_CLIENT_SECRET', 'GOOGLE_CLIENT_SECRET']) assert.equal(env[secret].sync, false, `${secret} must be entered in the dashboard, never committed`);
});

test('Dockerfile: every file it copies exists, and the entrypoint drops root after fixing the data disk', () => {
  const docker = read('Dockerfile'); const copied = docker.split('\n').filter((l) => /^COPY (?!--from)/.test(l)).flatMap((l) => l.replace(/^COPY\s+/, '').split(/\s+/).slice(0, -1));
  for (const f of copied.filter((x) => !x.includes('*'))) assert.ok(existsSync(join(root, f)), `Dockerfile copies ${f} but it does not exist`); // a missing file here breaks the Render build
  for (const f of ['package.json', 'package-lock.json']) assert.ok(existsSync(join(root, f)), `${f} is needed by npm ci`);
  assert.match(docker, /ENTRYPOINT \["docker-entrypoint\.sh"\]/); assert.match(docker, /su-exec/); assert.ok(!/^USER /m.test(docker), 'the entrypoint switches user itself');
  const sh = read('docker-entrypoint.sh'); assert.ok(!sh.includes('\r'), 'entrypoint must use LF line endings'); assert.match(sh, /^#!\/bin\/sh/); assert.match(sh, /su-exec node "\$@"/);
  assert.match(read('docker-compose.prod.yml'), /user: node/, 'hardened stack starts unprivileged (it drops all capabilities)');
});

test('behind Render\'s HTTPS proxy: Secure session cookie, working health/ready checks, WebSocket origin accepted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hc-render-')); process.env.HACKCONNECT_BASE_URL = 'https://hc-test.onrender.com';
  const app = createApp({ root, stateFile: join(dir, 'state.json'), authLimit: 1e6, autoBackupMinutes: 0, secureCookies: true }); await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); const port = app.server.address().port;
  const proxied = { host: 'hc-test.onrender.com', 'x-forwarded-proto': 'https', 'content-type': 'application/json', 'x-requested-with': 'hackconnect' };
  const call = (path, opts = {}) => new Promise((resolve, reject) => { const req = http.request({ host: '127.0.0.1', port, path, method: opts.method || 'GET', headers: { ...proxied, ...(opts.headers || {}) } }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }); req.on('error', reject); req.end(opts.body); });
  try {
    assert.equal((await call('/health')).status, 200); const ready = await call('/ready'); assert.equal(ready.status, 200); assert.equal(JSON.parse(ready.body).ready, true);
    const signup = await call('/api/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Render R', email: 'render@x.io', password: 'correct-horse-battery' }) }); assert.equal(signup.status, 201 === signup.status ? 201 : 200);
    const cookie = [].concat(signup.headers['set-cookie'] || []).join(';'); assert.match(cookie, /Secure/i, 'session cookie must be Secure over HTTPS'); assert.match(cookie, /HttpOnly/i);
    assert.equal((await call('/')).status, 200);
    const home = await call('/download/hackconnect-assistant.zip'); assert.equal(home.status, 200);
    const { WebSocket } = await import('ws'); const sid = cookie.split(';')[0];
    const me = JSON.parse((await call('/api/bootstrap', { headers: { cookie: sid } })).body); const pid = (await call('/api/projects', { method: 'POST', headers: { cookie: sid }, body: JSON.stringify({ name: 'WS' }) })).body; const projectId = JSON.parse(pid).id; assert.ok(me.user);
    const open = await new Promise((resolve) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?projectId=${projectId}&role=call`, { headers: { host: 'hc-test.onrender.com', origin: 'https://hc-test.onrender.com', cookie: sid } }); ws.on('open', () => { ws.close(); resolve(true); }); ws.on('close', (code) => resolve(code === 4403 ? false : true)); ws.on('error', () => resolve(false)); });
    assert.equal(open, true, 'WebSocket with the public origin must be accepted');
  } finally { delete process.env.HACKCONNECT_BASE_URL; await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
