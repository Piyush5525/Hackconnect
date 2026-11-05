// Assistant "sign in" acceptance in a real browser: choose Claude (sign in), see the bridge/CLI status card,
// save, ask a question, and get the answer that a (stand-in) Claude Code CLI on this computer produced.
// The stand-in `claude` is a tiny script on PATH, so no real account is needed.
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createApp } from '../lib/app.mjs';
import { startAgentBridge } from '../bridge/agent-bridge.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)); const dir = mkdtempSync(join(tmpdir(), 'hc-e2e-signin-')); const real = console.log; console.log = (...a) => { if (!String(a[0]).startsWith('[mail]')) real(...a); };
const step = (m) => real(`  ✓ ${m}`);
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 80)); } throw new Error(`timed out: ${fn}`); };

// stand-in Claude Code CLI
const bin = join(dir, 'bin'); await import('node:fs').then((fs) => fs.mkdirSync(bin));
writeFileSync(join(dir, 'fake-claude.mjs'), `const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('2.0.0 (stand-in)'); process.exit(0); }
if (a[0] === 'auth' && a[1] === 'status') process.exit(0);
let d = ''; process.stdin.on('data', (c) => (d += c)); process.stdin.on('end', () => console.log(JSON.stringify({ message: 'Stand-in Claude answered (' + (d.includes('"request"') ? 'got workspace context' : 'no context') + ').', changes: [{ path: 'from-claude.txt', content: 'hello from claude' }] })));
`);
if (process.platform === 'win32') writeFileSync(join(bin, 'claude.cmd'), `@echo off\r\nnode "${join(dir, 'fake-claude.mjs')}" %*\r\n`);
else { writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec node "${join(dir, 'fake-claude.mjs')}" "$@"\n`); chmodSync(join(bin, 'claude'), 0o755); }
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;

const app = createApp({ root, stateFile: join(dir, 's.json'), authLimit: 1e6, autoBackupMinutes: 0 }); await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch(); let bridge = null;
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base); await page.waitForSelector('#authGate'); await page.click('#authToggle'); await page.fill('#authName', 'Sign In'); await page.fill('#authEmail', 'signin@example.com'); await page.fill('#authPassword', 'a-long-password-1'); await page.click('#authSubmit'); await page.waitForSelector('#authGate', { state: 'detached' });
  const id = await page.evaluate(async () => { const r = await fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect' }, body: JSON.stringify({ name: 'Signin Room' }) }); return (await r.json()).id; });
  await page.evaluate((pid) => window.HackConnectApp.openProject(pid), id); await page.waitForSelector('#assistMode'); assert.equal(await page.locator('#assistSettings').count(), 0, 'no gear button in the assistant header'); step('workspace open');

  assert.ok((await page.textContent('#assistThread')).includes('demo mode')); await page.waitForSelector('#connectAi'); step('demo mode shows a "Connect your AI" button');

  // 1. bridge NOT running yet: the card explains how to start it
  await page.click('#assistMode'); await page.click('#bmFoot'); await page.waitForSelector('#aiProv'); await page.selectOption('#aiProv', 'local-claude'); await page.waitForSelector('#aiLocal:not([hidden]) .loc'); await until(async () => (await page.textContent('#aiLocal')).includes('Not running'));
  assert.equal(await page.getAttribute('#aiLocal a[download]', 'href'), '/download/hackconnect-assistant.zip?tool=claude'); if (process.env.HC_SHOTS) await page.locator('.hc-card').screenshot({ path: join(process.env.HC_SHOTS, 'signin-down.png') }); assert.equal(await page.isDisabled('#locSign'), true); assert.equal(await page.isVisible('#aiKey'), false, 'no API key field for sign-in providers'); step('bridge down: a one-click launcher download is offered, sign-in disabled, no key field');

  // 2. start the bridge, re-check: Claude Code is found and signed in
  bridge = await startAgentBridge({ origins: [base], port: 47831, log: () => {} }); await page.click('#locCheck'); await until(async () => (await page.textContent('#aiLocal')).includes('Signed in'));
  if (process.env.HC_SHOTS) await page.locator('.hc-card').screenshot({ path: join(process.env.HC_SHOTS, 'signin-up.png') }); assert.equal(await page.isDisabled('#locSign'), false); step('bridge up: Claude Code detected and signed in');

  // 3. the simple wizard connects by itself once the launcher is running and Claude Code is signed in
  await page.click('.hc-actions button:has-text("Cancel")'); await page.click('#connectAi'); await page.waitForSelector('.wz-card'); await until(async () => (await page.textContent('#assistMode')).includes('Claude')); await page.waitForSelector('.wz-card', { state: 'detached' }); step('wizard detected the launcher and Claude, connected automatically (header shows "Claude · your account")');
  const zip = await page.evaluate(async () => { const r = await fetch('/download/hackconnect-assistant.zip?tool=codex'); return [r.status, r.headers.get('content-type'), (await r.arrayBuffer()).byteLength]; }); assert.deepEqual(zip.slice(0, 2), [200, 'application/zip']); assert.ok(zip[2] > 3000); step('launcher zip downloads');
  // the model + edit-mode chips live in the composer bar
  await page.click('#assistApprove'); await page.waitForSelector('.bar-menu'); assert.ok((await page.textContent('.bar-menu')).includes('Ask first') && (await page.textContent('.bar-menu')).includes('Auto-apply')); await page.click('.bar-menu .bm-item:has-text("Auto-apply")'); await until(async () => (await page.textContent('#assistApprove')).includes('Auto-apply')); await page.click('#assistApprove'); await page.click('.bar-menu .bm-item:has-text("Ask first")'); await until(async () => (await page.textContent('#assistApprove')).includes('Ask first')); step('edit-mode chip switches Ask first / Auto-apply');
  await page.click('#assistMode'); await page.waitForSelector('.bar-menu .bm-item'); const names = await page.$$eval('.bar-menu .bm-item b', (e) => e.map((x) => x.textContent)); assert.ok(names.includes('Claude') && names.includes('Codex / ChatGPT') && names.includes('Demo mode'), names.join()); assert.ok((await page.textContent('.bar-menu .bm-item.on')).includes('Claude')); await page.keyboard.press('Escape'); step('model chip lists Claude, Codex, free and key-based models with the current one ticked');
  // every popup toggles: clicking its button again closes it
  const count = (sel) => page.locator(sel).count();
  await page.click('#wsMoreBtn'); assert.equal(await count('.more-menu'), 1); await page.click('#wsMoreBtn'); assert.equal(await count('.more-menu'), 0, '⋯ menu closes on second click');
  await page.click('#assistMode'); assert.equal(await count('.bar-menu'), 1); await page.click('#assistMode'); assert.equal(await count('.bar-menu'), 0, 'model menu closes on second click');
  await page.click('#assistApprove'); assert.equal(await count('.bar-menu'), 1); await page.click('#assistApprove'); assert.equal(await count('.bar-menu'), 0, 'edit-mode menu closes on second click');
  await page.click('#assistMode'); await page.click('#assistApprove'); assert.equal(await count('.bar-menu'), 1, 'opening another chip switches menus'); assert.ok((await page.textContent('.bar-menu')).includes('Auto-apply')); await page.keyboard.press('Escape');
  await page.click('.side-tabs [data-pane="chat"]'); await page.click('#emojiBtn'); assert.equal(await count('#chatPop'), 1); await page.click('#emojiBtn'); assert.equal(await count('#chatPop'), 0, 'emoji picker closes on second click'); await page.click('.side-tabs [data-pane="assistant"]');
  step('popups (⋯, model, edit mode, emoji) open on one click and close on the next');
  await page.fill('#agentPrompt', 'add a note file'); await page.click('#agentSend'); await until(async () => (await page.textContent('#assistThread')).includes('Stand-in Claude answered (got workspace context)')); step('answer came from the local Claude Code tool with workspace context');
  await until(async () => (await page.textContent('#proposalList')).includes('from-claude.txt') || (await page.textContent('#assistThread')).includes('from-claude.txt')); step('its file change is shown for approval');

  // past chats: the old "connect external agent" arrows are gone; + files the chat away, the clock brings it back
  assert.equal(await page.locator('#assistConnect').count(), 0, 'double-arrow button removed');
  await page.click('#assistHistory'); await page.waitForSelector('.hist-menu .hm-empty'); await page.click('#assistHistory'); assert.equal(await page.locator('.hist-menu').count(), 0, 'history popup toggles');
  await page.click('#assistNew'); await until(async () => !(await page.textContent('#assistThread')).includes('add a note file')); step('+ starts a fresh conversation');
  await page.click('#assistHistory'); await page.waitForSelector('.hm-row'); assert.ok((await page.textContent('.hist-menu')).includes('add a note file')); await page.click('.hm-row'); await until(async () => (await page.textContent('#assistThread')).includes('Stand-in Claude answered')); assert.equal(await page.locator('.hist-menu').count(), 0); step('clock lists the earlier chat and loads it back');

  // 4. bridge stopped: friendly error
  await new Promise((r) => bridge.close(r)); bridge = null; await page.fill('#agentPrompt', 'again'); await page.click('#agentSend'); await until(async () => (await page.textContent('#assistThread')).includes('Cannot reach the assistant bridge')); step('bridge stopped: clear "cannot reach the bridge" message');
  assert.deepEqual(errors, [], 'no page errors'); real('\nAssistant sign-in e2e passed');
} finally { if (bridge) await new Promise((r) => bridge.close(r)); await browser.close(); await app.close(); rmSync(dir, { recursive: true, force: true }); }
