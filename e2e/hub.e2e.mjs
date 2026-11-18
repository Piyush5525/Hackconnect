// Team hub on the Nexconn ChatUI SDK, end to end against the real Nexconn service: two people in two browsers talk in a
// project channel, get the bot's join notice, ask the shared assistant with /ai, leave a structured handover, start a
// thread and exchange direct messages. Needs NEXCONN_KEY / NEXCONN_SECRET (read from .env); without them it is skipped.
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createApp } from '../lib/app.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
if (existsSync(join(root, '.env'))) for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*(NEXCONN_[A-Z_]+)\s*=\s*(.*?)\s*$/); if (m) process.env[m[1]] ||= m[2]; }
if (!process.env.NEXCONN_KEY || !process.env.NEXCONN_SECRET) { console.log('  - skipped: NEXCONN_KEY / NEXCONN_SECRET are not set'); process.exit(0); }
process.env.HACKCONNECT_AGENT_PROVIDER = 'demo'; // the assistant's wording does not matter here, only that its answer reaches everyone

const dir = mkdtempSync(join(tmpdir(), 'hc-e2e-hub-')); const real = console.log; console.log = (...a) => { if (!String(a[0]).startsWith('[mail]') && !String(a[0]).startsWith('Hi ')) real(...a); };
const step = (m) => real(`  ✓ ${m}`); const shots = process.env.HC_SHOTS; const shot = async (page, name) => { if (shots) { await page.waitForTimeout(500); await page.screenshot({ path: join(shots, name) }); } };
const app = createApp({ root, stateFile: join(dir, 's.json'), authLimit: 1e6, autoBackupMinutes: 0 }); await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] }); // calls use a fake camera and microphone
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch {} await new Promise((r) => setTimeout(r, 150)); } throw new Error(`timed out: ${fn}`); };
try {
  const stamp = Date.now().toString(36);
  const mk = async (name, email, url = base) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone', 'camera'] }); const page = await ctx.newPage(); page.errors = [];
    page.on('pageerror', (e) => page.errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy|Refused to connect/i.test(m.text())) page.errors.push(m.text()); });
    await page.goto(url); await page.waitForSelector('#authGate'); await page.click('#authToggle'); await page.fill('#authName', name); await page.fill('#authEmail', email); await page.fill('#authPassword', 'a-long-password-1'); await page.click('#authSubmit'); await page.waitForSelector('#authGate', { state: 'detached' }); return page;
  };
  const call = (page, method, path, body) => page.evaluate(async ([m, p, b]) => (await fetch('/api' + p, { method: m, headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect' }, body: b ? JSON.stringify(b) : undefined })).json(), [method, path, body]);
  const openHub = async (page) => { await page.click('.nav button[data-view="hub"]'); await page.waitForSelector('#hubSide .hub-ch', { timeout: 45000 }); await page.waitForSelector('nc-chat-ui-app-provider'); };

  const a = await mk('Maya Rao', `maya-${stamp}@example.com`); const pid = (await call(a, 'POST', '/projects', { name: 'Campus Navigator', description: 'Indoor maps' })).id;
  await openHub(a); // the project's channels exist before the teammate arrives, as in real use
  const invite = await call(a, 'POST', `/projects/${pid}/invites`, { role: 'editor' }); const b = await mk('Arjun Nair', `arjun-${stamp}@example.com`, `${base}/?invite=${invite.token}`);
  await b.waitForFunction(() => window.HC?.state?.projects?.length > 0, null, { timeout: 15000 });
  await openHub(b); step('both people see the Team hub with the project channels');
  await a.click('#hubSide .hub-ch:has-text("general")'); await b.click('#hubSide .hub-ch:has-text("general")');
  const input = (page) => page.locator('nc-chat-ui-app-provider textarea');
  const say = async (page, text) => { await input(page).click(); await input(page).fill(text); await input(page).press('Enter'); };
  const sees = async (page, text, ms = 30000) => { try { await page.locator('nc-message-list-provider').getByText(text, { exact: false }).first().waitFor({ timeout: ms }); } catch (error) { if (shots) await page.screenshot({ path: join(shots, `failed-${Date.now()}.png`) }); throw error; } };
  const botLines = (page) => page.locator('nc-message-list-provider').getByText('HackConnect AI', { exact: true }).count();

  await sees(b, 'Arjun Nair joined Campus Navigator'); step('the bot welcomed the new teammate in #general');
  assert.ok(await botLines(b) >= 1, 'bot messages are labelled HackConnect AI, not its raw id');
  await say(a, `Hello team ${stamp}`); await sees(b, `Hello team ${stamp}`); step('a message in #general reaches the teammate in real time');

  const before = await botLines(b); await say(a, '/ai what should we build first?'); await sees(b, '/ai what should we build first?');
  await until(async () => (await botLines(b)) > before, 45000); step('/ai: the question and the assistant answer reach everyone in the channel');
  await shot(b, 'hub-general.png');

  await a.click('#hubSide .hub-ch:has-text("handover")'); await a.locator('nc-channel-detail-bar-provider img.extension-icon').nth(2).click();
  await a.fill('#hoDone', `Login flow done ${stamp}`); await a.fill('#hoNext', 'Wire the leaderboard'); await a.fill('#hoBlocked', 'Judging rubric'); await a.fill('#hoUntil', '9am');
  await a.click('.hc-modal .primary-button'); await b.click('#hubSide .hub-ch:has-text("handover")');
  await b.locator('nc-c-handover').getByText(`Login flow done ${stamp}`).waitFor({ timeout: 30000 }); step('a structured handover card is posted and rendered for the teammate');
  await shot(b, 'hub-handover.png');

  await a.click('#hubThread'); await a.fill('#thName', 'API design'); await a.click('.hc-modal [data-act=ok]');
  await a.waitForSelector('#hubSide .hub-ch:has-text("api-design")'); await a.waitForTimeout(800); await say(a, `Endpoints draft ${stamp}`);
  await b.waitForSelector('#hubSide .hub-ch:has-text("api-design")', { timeout: 30000 }); await b.click('#hubSide .hub-ch:has-text("api-design")'); await sees(b, `Endpoints draft ${stamp}`);
  step('a new thread shows up for the teammate as soon as someone writes in it');

  await a.click('#hubSide .hub-person:has-text("Arjun Nair")'); await a.waitForTimeout(800); await say(a, `Direct hello ${stamp}`);
  await b.waitForFunction(() => Number(document.querySelector('#hubCount')?.textContent || 0) > 0, null, { timeout: 30000 }); step('an unread direct message shows on the Team hub badge');
  await b.click('#hubSide .hub-person:has-text("Maya Rao")'); await sees(b, `Direct hello ${stamp}`); step('direct messages work between teammates');
  await shot(b, 'hub-dm.png');

  // Calls on Nexconn Call: Maya video-calls Arjun from their direct conversation.
  await a.locator('nc-channel-detail-bar-provider img.extension-icon').first().click(); await a.click('.hc-modal [data-act=video]');
  const outcome = await Promise.race([b.waitForSelector('#nxRing', { timeout: 30000 }).then(() => 'ringing'), a.waitForFunction(() => document.body.innerText.includes('Calling is not switched on'), null, { timeout: 30000 }).then(() => 'disabled')]);
  if (outcome === 'disabled') step('calls: Nexconn reports the Call service is not enabled for this app yet (80006); the user sees a clear message. Call steps skipped');
  else {
    step('a video call rings the teammate'); await b.click('#nxRing [data-a=yes]');
    await a.waitForFunction(() => window.HC.nxCall.state.phase === 'live', null, { timeout: 30000 }); await b.waitForFunction(() => window.HC.nxCall.state.phase === 'live', null, { timeout: 30000 });
    await a.waitForSelector('#nxStage .nx-tile:not(.me)'); step('both sides are connected in the call window'); await shot(a, 'call.png');
    await a.click('#nxStage [data-a=end]'); await b.waitForFunction(() => window.HC.nxCall.state.phase === 'idle', null, { timeout: 20000 }); step('hanging up ends the call for both');
  }

  await a.evaluate((id) => window.HC.openProject(id), pid); await a.click('.side-tabs button[data-pane="chat"]');
  await a.locator('#messages .nx-msg', { hasText: `Hello team ${stamp}` }).waitFor({ timeout: 30000 }); step('the Live workspace chat shows the project #general from Nexconn');
  await b.click('#hubSide .hub-ch:has-text("general")'); await a.fill('#chatMessage', `From the editor ${stamp}`); await a.press('#chatMessage', 'Enter');
  await sees(b, `From the editor ${stamp}`); await a.locator('#messages .nx-msg', { hasText: `From the editor ${stamp}` }).waitFor({ timeout: 10000 });
  step('a message sent from the workspace chat reaches the teammate in the Team hub');
  await shot(a, 'workspace-chat.png');

  assert.deepEqual(a.errors, [], 'no page errors or blocked connections for Maya'); assert.deepEqual(b.errors, [], 'no page errors or blocked connections for Arjun');
  step('no page errors and nothing blocked by the Content Security Policy');
} finally { await browser.close(); await app.close(); }
