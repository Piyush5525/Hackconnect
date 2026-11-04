import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../lib/app.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)); const cli = join(root, 'bridge', 'cli.mjs');
let app, base, dir, cfg;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hc-cli-')); cfg = mkdtempSync(join(tmpdir(), 'hc-cfg-'));
  app = createApp({ root, stateFile: join(dir, 'state.json'), authLimit: 1000 }); await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); rmSync(cfg, { recursive: true, force: true }); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(50); } throw new Error(`timed out: ${fn}`); };
const run = (args, { stdin } = {}) => { const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, HACKCONNECT_CONFIG_DIR: cfg, BROWSER: 'none', HACKCONNECT_NO_BROWSER: '1' }, windowsHide: true }); const out = { text: '', child }; child.stdout.on('data', (d) => { out.text += d; }); child.stderr.on('data', (d) => { out.text += d; }); if (stdin) child.stdin.end(stdin); out.done = new Promise((r) => child.on('close', (code) => r(code))); return out; };

test('hackconnect CLI: login by device code, list workspaces, share with consent', async () => {
  const help = run(['help']); assert.equal(await help.done, 0); assert.match(help.text, /Agent prompts and conversations are never captured/);
  const unauth = run(['workspaces']); assert.equal(await unauth.done, 1); assert.match(unauth.text, /Not signed in/);

  // sign up a human, run `login`, approve the code the CLI prints
  const su = await fetch(`${base}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect' }, body: JSON.stringify({ name: 'Cli Tester', email: 'cli@x.io', password: 'correct-horse-battery' }) }); const cookie = su.headers.get('set-cookie').split(';')[0];
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect', cookie }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const login = run(['login', '--server', base]); const code = await until(() => /Code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(login.text)?.[1]);
  assert.equal((await post('/api/device/approve', { userCode: code })).status, 200); assert.equal(await login.done, 0); assert.match(login.text, /Signed in as Cli Tester/);
  assert.ok(existsSync(join(cfg, 'config.json'))); assert.match(readFileSync(join(cfg, 'config.json'), 'utf8'), /"token": "hc_/);
  const status = run(['status']); await status.done; assert.match(status.text, /Signed in to/);

  const ws = (await post('/api/projects', { name: 'CLI Room' })).body.id;
  const list = run(['workspaces']); assert.equal(await list.done, 0); assert.ok(list.text.includes(ws));

  // declining consent shares nothing
  const folder = mkdtempSync(join(tmpdir(), 'hc-share-')); writeFileSync(join(folder, 'hello.txt'), 'hi from the cli\n'); writeFileSync(join(folder, '.env'), 'SECRET=1\n');
  const declined = run(['share', folder, '--workspace', ws], { stdin: 'n\n' }); assert.equal(await declined.done, 1); assert.match(declined.text, /Nothing was shared/);
  assert.equal(app.db.projects.find((p) => p.id === ws).files['hello.txt'], undefined);

  // consenting shares the folder live, never the .env, and prints the sharing indicator
  const share = run(['share', folder, '--workspace', ws, '--yes']); await until(() => share.text.includes('SHARING'));
  await until(() => app.db.projects.find((p) => p.id === ws).files['hello.txt'] === 'hi from the cli\n'); assert.equal(app.db.projects.find((p) => p.id === ws).files['.env'], undefined);
  writeFileSync(join(folder, 'later.txt'), 'added while sharing\n'); await until(() => app.db.projects.find((p) => p.id === ws).files['later.txt'] === 'added while sharing\n');
  share.child.kill(); await share.done; rmSync(folder, { recursive: true, force: true });

  const out = run(['logout']); await out.done; assert.ok(!existsSync(join(cfg, 'config.json')));
  const term = run(['terminal']); assert.equal(await term.done, 1);
});

test('the CLI never opens a browser window unless it runs in an interactive terminal', async () => {
  const src = readFileSync(cli, 'utf8'); assert.match(src, /process\.stdout\.isTTY && !process\.env\.HACKCONNECT_NO_BROWSER/, 'browser launch is gated');
  const launcher = readFileSync(join(root, 'scripts', 'start.mjs'), 'utf8'); assert.match(launcher, /HACKCONNECT_NO_BROWSER/);
  // no test may spawn the OS "open a URL" helper: scan test files for it
  for (const f of ['api', 'collab', 'events', 'platform', 'oauth', 'mail', 'tunnel', 'ops', 'history', 'ci']) assert.ok(!/['"]xdg-open['"]|\bstart['"], ['"]['"]/.test(readFileSync(join(root, 'test', `${f}.test.mjs`), 'utf8')), `${f}.test.mjs must not open browsers`);
});
