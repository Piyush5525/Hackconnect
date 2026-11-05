// A teammate is in a call and invites others. The invited person gets (1) a live "Join" prompt and (2) an inbox message with a
// "Join call" button; clicking either puts them straight into the call. Fake camera/microphone, two real browsers.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createApp } from '../lib/app.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)); const dir = mkdtempSync(join(tmpdir(), 'hc-e2e-callinv-')); const real = console.log; console.log = (...a) => { if (!String(a[0]).startsWith('[mail]')) real(...a); };
const step = (m) => real(`  ✓ ${m}`);
const until = async (fn, ms = 12000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 80)); } throw new Error(`timed out: ${fn}`); };
const app = createApp({ root, stateFile: join(dir, 's.json'), authLimit: 1e6, autoBackupMinutes: 0 }); await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
try {
  const mk = async (name, email, url = base) => { const ctx = await browser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message)); await page.goto(url); await page.waitForSelector('#authGate'); await page.click('#authToggle'); await page.fill('#authName', name); await page.fill('#authEmail', email); await page.fill('#authPassword', 'correct-horse-battery'); await page.click('#authSubmit'); await page.waitForSelector('#authGate', { state: 'detached' }); return page; };
  const call = (page, method, path, body) => page.evaluate(async ([m, p, b]) => (await fetch('/api' + p, { method: m, headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect' }, body: b ? JSON.stringify(b) : undefined })).json(), [method, path, body]);
  const a = await mk('Host Person', 'host@example.com'); const pid = (await call(a, 'POST', '/projects', { name: 'Call Room' })).id;
  const invite = await call(a, 'POST', `/projects/${pid}/invites`, { role: 'editor' }); const b = await mk('Guest Person', 'guest@example.com', `${base}/?invite=${invite.token}`);
  const invite2 = await call(a, 'POST', `/projects/${pid}/invites`, { role: 'viewer' }); const c = await mk('Third Person', 'third@example.com', `${base}/?invite=${invite2.token}`);
  await a.evaluate((id) => window.HackConnectApp.openProject(id), pid); await a.waitForSelector('.collab-panel'); step('three people are in one project');

  // nobody else in the project yet? (checked first with a lone user elsewhere) then: host joins the call
  await a.evaluate(() => window.HC.call.join(window.HC.state.currentProject.id, 'general')); await until(() => a.isVisible('#callDock')); step('host is in the call');
  await a.click('#callDock [data-a="invite"]'); await a.waitForSelector('.inv-pop .inv-row'); assert.equal(await a.locator('.inv-pop .inv-row').count(), 2); assert.equal(await a.locator('.inv-pop input:checked').count(), 2); if (process.env.HC_SHOTS) await a.screenshot({ path: join(process.env.HC_SHOTS, 'invite-picker.png') }); step('invite picker lists both teammates, preselected');
  await a.click('#callDock [data-a="invite"]'); assert.equal(await a.locator('.inv-pop').count(), 0); step('clicking the invite button again closes the picker');
  await a.click('#callDock [data-a="invite"]'); await a.waitForSelector('.inv-pop .inv-row'); await a.locator('.inv-pop .inv-row', { hasText: 'Third Person' }).locator('input').uncheck(); assert.ok((await a.textContent('#invSend')).includes('Invite 1')); await a.click('#invSend'); await until(async () => (await a.textContent('.toast')).includes('Invited 1 teammate')); step('host invites only the guest');

  // guest: a live prompt pops up right away (they have the project open); third person gets nothing
  await b.waitForSelector('.call-invite'); assert.ok((await b.textContent('.call-invite')).includes('Host Person invited you to a call')); if (process.env.HC_SHOTS) await b.screenshot({ path: join(process.env.HC_SHOTS, 'invite-toast.png') }); step('guest sees a live "Join" prompt immediately');
  await b.click('.call-invite [data-no]'); await b.waitForSelector('.call-invite',{state:'detached'});
  await b.evaluate(() => document.querySelector('[data-view="overview"]').click()); // leave the project view
  await b.click('#notifBtn'); await b.waitForSelector('.ibx .ibx-join'); assert.ok((await b.textContent('.ibx')).includes('Host Person invited you to join the call')); step('guest inbox shows "Host Person invited you to join the call" with a Join call button');
  assert.equal(await c.evaluate(async () => (await (await fetch('/api/notifications')).json()).notifications.filter((n) => n.ref?.kind === 'call').length), 0); step('the teammate who was not picked gets no invite');
  if (process.env.HC_SHOTS) await b.screenshot({ path: join(process.env.HC_SHOTS, 'invite-inbox.png') }); await b.click('.ibx .ibx-join'); await b.waitForSelector('#callDock', { timeout: 15000 }); await until(async () => (await b.textContent('#callDock .cd-title')).includes('General')); await until(async () => (await a.textContent('#callDock .cd-title')).includes('2 in call')); step('clicking Join call opens the project and puts the guest in the same call (host sees 2 in call)');
  assert.deepEqual([...a.errors, ...b.errors, ...c.errors], [], 'no page errors'); real('\nCall invite e2e passed');
} finally { await browser.close(); await app.close(); rmSync(dir, { recursive: true, force: true }); }
