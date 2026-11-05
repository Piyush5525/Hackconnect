// Split deployment acceptance: the built frontend (dist/, as Vercel serves it) lives on one address and proxies /api to the
// backend on another address, exactly like vercel.json does. Live sockets go straight to the backend with a one-time ticket.
// Two browsers sign in through the "Vercel" address, share a workspace, and must still sync live (chat + shared editor).
// Run: npm run e2e:split
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createApp } from '../lib/app.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)); const dir = mkdtempSync(join(tmpdir(), 'hc-e2e-split-'));
const step = (m) => console.log(`  ✓ ${m}`);
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 60)); } throw new Error(`timed out: ${fn}`); };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.webmanifest': 'application/manifest+json' };

// 1. the "Vercel" side: a stand-in frontend address that serves dist/ and proxies the HTTP routes of vercel.json (but not WebSockets)
const front = http.createServer(); await new Promise((r) => front.listen(0, '127.0.0.1', r)); const frontBase = `http://127.0.0.1:${front.address().port}`;
// 2. the "Render" side: the real backend, which only accepts live sockets from the frontend address
process.env.HACKCONNECT_ALLOWED_ORIGINS = frontBase;
const app = createApp({ root, stateFile: join(dir, 's.json'), authLimit: 1e6, autoBackupMinutes: 0 }); await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); const backPort = app.server.address().port; const backBase = `http://127.0.0.1:${backPort}`;

// build dist for this backend address (the real build reads vercel.json; --backend overrides it for the test)
execFileSync(process.execPath, [join(root, "scripts", "build-frontend.mjs"), `--backend=${backBase}`], { cwd: root, stdio: "pipe" });
const dist = join(root, 'dist'); const PROXIED = /^\/(api|download|t|mcp|health)(\/|$)/;
front.on('request', (req, res) => {
  const path = new URL(req.url, frontBase).pathname;
  if (PROXIED.test(path)) {
    const up = http.request({ host: '127.0.0.1', port: backPort, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${backPort}` } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(up); return;
  }
  const file = join(dist, path === '/' ? 'index.html' : path.slice(1));
  if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' }); res.end(readFileSync(file));
});
front.on('upgrade', (req, socket) => socket.destroy()); // like Vercel: no WebSocket proxying

const browser = await chromium.launch();
try {
  const signUp = async (ctx, name, email, url = frontBase) => { const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message)); await page.goto(url); await page.waitForSelector('#authGate'); await page.click('#authToggle'); await page.fill('#authName', name); await page.fill('#authEmail', email); await page.fill('#authPassword', 'correct-horse-battery'); await page.click('#authSubmit'); await page.waitForSelector('#authGate', { state: 'detached' }); return page; };
  const call = (page, method, path, body) => page.evaluate(async ([m, p, b]) => (await fetch('/api' + p, { method: m, headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect' }, body: b ? JSON.stringify(b) : undefined })).json(), [method, path, body]);

  const a = await signUp(await browser.newContext(), 'Split Owner', 'owner@example.com'); step('signed in through the frontend address (cookie + /api proxy work)');
  assert.equal(await a.evaluate(() => window.HACKCONNECT_BACKEND), backBase); step('frontend knows the backend address (config.js)');
  const pid = (await call(a, 'POST', '/projects', { name: 'Split Room' })).id;
  const invite = await call(a, 'POST', `/projects/${pid}/invites`, { role: 'editor' });
  const b = await signUp(await browser.newContext(), 'Split Guest', 'guest@example.com', `${frontBase}/?invite=${invite.token}`); step('teammate joined through an invite link on the frontend address');
  for (const page of [a, b]) { await page.evaluate((id) => window.HackConnectApp.openProject(id), pid); await page.waitForSelector('.monaco-editor'); }
  await until(async () => (await a.textContent('#saveState')).includes('Live') && (await b.textContent('#saveState')).includes('Live')); step('shared editor connected straight to the backend with a ticket ("Live · synced")');
  await until(async () => (await a.textContent('#peerStrip')).includes('Split Guest')); step('presence (room socket) works across addresses');
  await a.evaluate(() => { window.hcEditor.focus(); window.hcEditor.setPosition({ lineNumber: 1, column: 1 }); }); await a.keyboard.type('hello-split', { delay: 15 });
  await until(async () => (await b.evaluate(() => window.hcEditor.getValue())).includes('hello-split')); step('typing on one side appears on the other');

  // security: tickets are single-use, and a socket without one is refused
  const { ticket } = await a.evaluate(async () => (await fetch('/api/ws-ticket', { method: 'POST', headers: { 'x-requested-with': 'hackconnect' } })).json());
  const probe = (url, origin) => a.evaluate(([u, o]) => new Promise((resolve) => { const ws = new WebSocket(u); ws.onclose = (e) => resolve(e.code); ws.onopen = () => setTimeout(() => ws.close(1000), 200); }), [url, origin]);
  const wsBase = backBase.replace('http', 'ws'); const room = `/ws?projectId=${pid}`;
  assert.equal(await probe(`${wsBase}${room}`), 4401); step('a socket with no ticket and no same-site cookie is refused (4401)');
  assert.equal(await probe(`${wsBase}${room}&ticket=${ticket}`), 1000); assert.equal(await probe(`${wsBase}${room}&ticket=${ticket}`), 4401); step('a ticket works once, then is dead');
  assert.deepEqual([...a.errors, ...b.errors], [], 'no page errors'); console.log('\nSplit deployment e2e passed');
} finally { await browser.close(); front.close(); await app.close(); rmSync(dir, { recursive: true, force: true }); rmSync(join(root, 'dist'), { recursive: true, force: true }); }
