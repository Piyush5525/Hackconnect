// Two people in a call: right-click a person to set their volume / mute them for you; sharing a screen must NOT take over the layout.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createApp } from '../lib/app.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)); const dir = mkdtempSync(join(tmpdir(), 'hc-e2e-vol-')); const real = console.log; console.log = (...a) => { if (!String(a[0]).startsWith('[mail]')) real(...a); };
const step = (m) => real(`  ✓ ${m}`);
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 80)); } throw new Error(`timed out: ${fn}`); };
const app = createApp({ root, stateFile: join(dir, 's.json'), authLimit: 1e6, autoBackupMinutes: 0 }); await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
try {
  const mk = async (name, email, url = base) => { const ctx = await browser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1600, height: 900 } }); const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message)); await page.goto(url); await page.waitForSelector('#authGate'); await page.click('#authToggle'); await page.fill('#authName', name); await page.fill('#authEmail', email); await page.fill('#authPassword', 'correct-horse-battery'); await page.click('#authSubmit'); await page.waitForSelector('#authGate', { state: 'detached' }); return page; };
  const call = (page, method, path, body) => page.evaluate(async ([m, p, b]) => (await fetch('/api' + p, { method: m, headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect' }, body: b ? JSON.stringify(b) : undefined })).json(), [method, path, body]);
  const a = await mk('Alpha One', 'alpha@example.com'); const pid = (await call(a, 'POST', '/projects', { name: 'Vol Room' })).id; const inv = await call(a, 'POST', `/projects/${pid}/invites`, { role: 'editor' }); const b = await mk('Beta Two', 'beta@example.com', `${base}/?invite=${inv.token}`);
  for (const p of [a, b]) { await p.evaluate((id) => window.HackConnectApp.openProject(id), pid); await p.waitForSelector('.collab-panel'); }
  for (const p of [a, b]) await p.evaluate(() => window.HC.call.join(window.HC.state.currentProject.id, 'general'));
  await until(async () => (await a.evaluate(() => [...window.HC.call.state.peers.values()].filter((x) => x.audio).length)) === 1); step('both in the call; each person has their own audio output');

  await a.click('#callDock [data-a="expand"]'); await a.waitForSelector('#callStage.full'); await until(async () => (await a.locator('#callStage .ct').count()) === 2);
  const betaTile = a.locator('#callStage .ct:not([data-id="self"])'); await betaTile.click({ button: 'right' }); await a.waitForSelector('.vol-menu'); assert.ok((await a.textContent('.vol-menu')).includes('Beta Two')); if (process.env.HC_SHOTS) { await a.waitForTimeout(400); await a.screenshot({ path: join(process.env.HC_SHOTS, 'vol-menu.png') }); } step('right-click on a person opens their volume menu');
  const vol = () => a.evaluate(() => { const p = [...window.HC.call.state.peers.values()][0]; return { v: Math.round(p.audio.volume * 100), muted: p.audio.muted }; });
  await a.locator('.vol-menu input[type=range]').fill('30'); await until(async () => (await vol()).v === 30); step("slider sets that person's volume to 30%");
  await a.click('.vol-menu [data-k="mute"]'); await until(async () => (await vol()).muted); assert.ok(await a.locator('#callStage .ct .mic-off[title="Muted for you"]').count() >= 1); step('"Mute for me" silences them and marks the tile');
  await a.click('.vol-menu [data-k="mute"]'); await until(async () => !(await vol()).muted); await a.click('.vol-menu [data-k="reset"]'); await until(async () => (await vol()).v === 100); step('unmute and reset bring them back to 100%');
  await a.keyboard.press('Escape'); assert.equal(await a.locator('.vol-menu').count(), 0);
  const saved = await a.evaluate(() => localStorage.getItem('hc.call.volumes')); assert.ok(saved.includes('"v":1')); step('their setting is remembered for next time');

  // sharing does not take over: still the grid, nobody pinned
  await a.evaluate(() => { navigator.mediaDevices.getDisplayMedia = async () => { const c = document.createElement('canvas'); c.width = 1280; c.height = 720; const x = c.getContext('2d'); setInterval(() => { x.fillStyle = '#123'; x.fillRect(0, 0, 1280, 720); }, 100); return c.captureStream(10); }; });
  await a.click('#callStage [data-a="share"]'); await until(async () => (await a.locator('#callStage .ct.share').count()) === 1);
  assert.equal(await a.locator('#callStage .call-main').count(), 0, 'no spotlight tile'); assert.equal(await a.evaluate(() => window.HC.call.state.pinned), null); assert.ok(await a.evaluate(() => window.HC.call.state.layout === 'grid')); assert.equal(await a.locator('#callStage .ct').count(), 3); if (process.env.HC_SHOTS) await a.screenshot({ path: join(process.env.HC_SHOTS, 'vol-share-grid.png') }); step('screen share keeps the grid (screen + two people as tiles), nothing pinned');
  assert.deepEqual([...a.errors, ...b.errors], [], 'no page errors'); real('\nCall volume e2e passed');
} finally { await browser.close(); await app.close(); rmSync(dir, { recursive: true, force: true }); }
