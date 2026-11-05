// Phase 2 acceptance: two real browsers sign up, join one workspace, type concurrently, and converge.
// Run: npm run e2e   (starts its own server on a random port with a temp state file)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createApp } from '../lib/app.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'hc-e2e-'));
const app = createApp({ root, stateFile: join(dir, 'state.json'), authLimit: 1000 });
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch();
const val = (p) => p.evaluate(() => window.hcEditor?.getValue() ?? '');
const step = (msg) => console.log(`  ✓ ${msg}`);
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch {} await new Promise((r) => setTimeout(r, 50)); } throw new Error(`timed out: ${fn}`); };

async function signUp(context, name, email, url = base) {
  const page = await context.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(process.env.E2E_STACK ? e.stack : e.message));
  await page.goto(url); await page.waitForSelector('#authGate');
  await page.click('#authToggle'); await page.fill('#authName', name); await page.fill('#authEmail', email); await page.fill('#authPassword', 'correct-horse-battery'); await page.click('#authSubmit');
  await page.waitForSelector('#authGate', { state: 'detached' }); page.errors = errors; return page;
}

try {
  const ctxA = await browser.newContext(); const ctxB = await browser.newContext();
  const a = await signUp(ctxA, 'Priya Patel', 'priya@example.com'); step('user A signed up (sees sign-in gate first)');
  const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => (await fetch('/api' + p, { method: m, headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect' }, body: b ? JSON.stringify(b) : undefined })).json(), [method, path, body]);
  const created = await api(a, 'POST', '/projects', { name: 'Pulseboard', description: 'Real-time hackathon progress tracker for builders' }); const pid = created.id;
  await api(a, 'POST', `/projects/${pid}/import`, { overwrite: true, files: [{ path: 'ActivityFeed.tsx', content: 'export function ActivityFeed() { return null }\n' }, { path: 'styles.css', content: '.app { display: grid; }\n' }, { path: 'package.json', content: '{ "name": "pulseboard" }\n' }] });
  await a.reload(); await a.waitForSelector('#profileBtn'); step('user A created a project and imported files');
  const openWorkspace = async (page) => { await page.click('[data-view="projects"]'); await page.click('#projectsView .pcard'); await page.click('#ppOpen'); await page.waitForSelector('.monaco-editor'); };

  // Invite B as editor through the real API (the UI button copies the same link)
  const invite = await api(a, 'POST', `/projects/${pid}/invites`, { role: 'editor' });
  assert.ok(invite.token);
  const b = await signUp(ctxB, 'Rahul Rao', 'rahul@example.com', `${base}/?invite=${invite.token}`); step('user B signed up via invite link');
  await b.waitForSelector('#profileBtn'); await b.click('[data-view="projects"]'); await b.waitForSelector('#projectsView .pcard'); step('user B sees the shared project');

  for (const page of [a, b]) await openWorkspace(page);
  await until(async () => (await a.textContent('#saveState')).includes('Live') && (await b.textContent('#saveState')).includes('Live')); step('both editors report "Live · synced"');
  await until(async () => { const [x, y] = await Promise.all([val(a), val(b)]); return x.includes('# Pulseboard') && x === y; }); step('both see the same initial file');

  // Concurrent typing at the same spot, no waiting between keystrokes
  await Promise.all([a, b].map((p) => p.evaluate(() => { window.hcEditor.focus(); window.hcEditor.setPosition({ lineNumber: 1, column: 1 }); })));
  await Promise.all([a.keyboard.type('AAAAAAAAAA', { delay: 15 }), b.keyboard.type('BBBBBBBBBB', { delay: 15 })]);
  const converged = await until(async () => { const [x, y] = await Promise.all([val(a), val(b)]); return x === y && (x.match(/A/g) || []).length >= 10 && (x.match(/B/g) || []).length >= 10 ? x : null; });
  step('concurrent typing converged to identical text, no keystrokes lost');

  // Presence strip shows the other person
  await until(async () => (await a.textContent('#peerStrip')).includes('Rahul Rao')); step('A sees B in the presence strip');
  await until(async () => (await b.textContent('#peerStrip')).includes('Priya Patel')); step('B sees A in the presence strip');

  // Cursor stability: B has caret mid-document, A inserts at the very start; B's caret must shift, not jump
  await b.evaluate(() => { const m = window.hcEditor.getModel(); window.hcEditor.focus(); window.hcEditor.setPosition(m.getPositionAt(40)); });
  await a.evaluate(() => { window.hcEditor.focus(); window.hcEditor.setPosition({ lineNumber: 1, column: 1 }); });
  await a.keyboard.type('// hi\n', { delay: 10 });
  await until(async () => (await val(b)).startsWith('// hi'));
  assert.equal(await b.evaluate(() => { const m = window.hcEditor.getModel(); return m.getOffsetAt(window.hcEditor.getPosition()); }), 46); step("remote insert before B's caret moved it (40 → 46) instead of resetting it");

  // Follow mode: B follows A after A switches files
  await a.click('.trow[data-path="styles.css"]');
  await b.click('[data-peer]'); await until(async () => (await b.textContent('#activeFile')).includes('styles.css')); step('B follows A into styles.css');

  // Reload keeps data; offline edit syncs on reconnect
  await ctxB.setOffline(true); app.dropCollabConnections();
  await until(async () => /Offline|Reconnecting/.test(await b.textContent('#saveState')), 15000); step('B shows offline/reconnecting status');
  await b.evaluate(() => window.hcEditor.focus()); await b.keyboard.press('Control+End'); await b.keyboard.type('/* offline-edit */');
  await ctxB.setOffline(false);
  await until(async () => (await val(a)).includes('offline-edit') || (await a.evaluate(() => document.querySelector('#activeFile').textContent)) !== 'styles.css', 20000);
  await a.click('.trow[data-path="styles.css"]'); await until(async () => (await val(a)).includes('offline-edit'), 20000); step('offline edit from B merged to A after reconnect');

  // Persistence: durable in server state (debounced) and visible via REST after reload
  await until(() => Object.values(app.db.projects.find((p) => p.id === pid).files).some((f) => f.includes('offline-edit')), 6000); step('edits persisted to server state');
  assert.deepEqual(a.errors, []); assert.deepEqual(b.errors, []); step('no uncaught browser errors');
  console.log('\nEditor e2e PASSED');
} catch (error) {
  console.error('\nEditor e2e FAILED:', error.message); process.exitCode = 1;
} finally {
  await browser.close(); await app.close(); rmSync(dir, { recursive: true, force: true });
}
