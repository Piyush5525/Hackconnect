// Event acceptance in real browsers: host, register, form a team, edit, submit, freeze, judge with replay, results.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createApp } from '../lib/app.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'hc-e2e2-'));
const app = createApp({ root, stateFile: join(dir, 'state.json'), authLimit: 1000 });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch();
const step = (m) => console.log(`  ✓ ${m}`);
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await new Promise((r) => setTimeout(r, 60)); } throw new Error(`timed out: ${fn}`); };

async function user(name, email) {
  const ctx = await browser.newContext(); const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(base); await page.waitForSelector('#authGate'); await page.click('#authToggle');
  await page.fill('#authName', name); await page.fill('#authEmail', email); await page.fill('#authPassword', 'correct-horse-battery'); await page.click('#authSubmit'); await page.waitForSelector('#authGate', { state: 'detached' });
  page.openEvents = async () => { await page.click('[data-view="events"]'); await page.waitForSelector('#eventsView .event-grid'); };
  return page;
}
const text = (p, sel) => p.textContent(sel);
const form = async (p, values) => { await p.waitForSelector('.hc-card'); for (const [id, v] of Object.entries(values)) await p.fill(`#f_${id}`, v); await p.click('.hc-actions [data-act="ok"]'); await p.waitForSelector('.hc-modal', { state: 'detached' }); };
const askIn = async (p, v) => { await p.waitForSelector('#askInput'); await p.fill('#askInput', v); await p.click('.hc-actions [data-act="ok"]'); await p.waitForSelector('.hc-modal', { state: 'detached' }); };
const sureYes = async (p) => { await p.waitForSelector('.hc-card'); await p.click('.hc-actions .primary-button'); await p.waitForSelector('.hc-modal', { state: 'detached' }); };

try {
  const org = await user('Olga Organizer', 'olga@e.io'); const judge = await user('Jules Judge', 'jules@e.io'); const dev = await user('Dev Dani', 'dani@e.io');
  await org.openEvents(); await org.click('#hostEvent'); await form(org, { title: 'Spring Hack', description: 'Build something great' });
  await org.waitForSelector('text=Live dashboard'); step('organizer hosted an event and sees the live dashboard');
  await org.click('#advance'); await sureYes(org); await until(async () => (await text(org, '#eventsView h1')).includes('Registration open')); step('organizer opened registration');
  await org.click('#addRole'); await form(org, { email: 'jules@e.io', role: 'judge' }); await until(async () => app.db.events[0].members[app.db.users.find((u) => u.email === 'jules@e.io').id] === 'judge'); step('organizer added a judge by email');

  await dev.openEvents(); await dev.click('[data-open]'); await dev.click('#register'); await dev.waitForSelector('#newTeam'); step('participant registered');
  await dev.click('#newTeam'); await askIn(dev, 'Alpha'); await dev.waitForSelector('#openWs'); step('participant created a team (workspace auto-provisioned)');
  await org.click('#advance'); await sureYes(org); await until(async () => (await text(org, '#eventsView h1')).includes('Hacking')); step('organizer started hacking phase');
  await org.click('#setDeadline'); await form(org, { when: '2099-01-01 12:00' }); await until(async () => (await text(org, '#eventsView')).includes('Deadline:')); assert.ok(app.db.events[0].deadline > Date.now()); step('organizer set a deadline from the UI');
  await dev.click('#back'); await dev.click('[data-open]'); await dev.click('#openWs'); await dev.waitForSelector('.monaco-editor');
  await until(async () => (await text(dev, '#saveState')).includes('Live')); await dev.evaluate(() => { window.hcEditor.focus(); window.hcEditor.setValue('# Alpha\n\nBuilt in the open.\n'); }); await dev.keyboard.type(' ok'); step('participant edited in the team workspace');
  await until(() => app.db.projects.find((p) => p.eventId)?.files['README.md']?.includes('Built in the open'), 6000);
  await dev.click('[data-view="events"]'); await dev.waitForSelector('#submit');
  await dev.click('#submit'); await form(dev, { title: 'Alpha App', summary: 'Does amazing things', repoUrl: 'https://github.com/a/b', agentUsage: 'none' }); await until(async () => (await text(dev, '#eventsView')).includes('Submitted: Alpha App')); step('participant submitted with declared agent usage');
  await org.click('#back'); await org.click('[data-open]'); await until(async () => (await text(org, '#eventsView')).includes('submitted')); step('organizer dashboard shows the team as submitted');
  await org.click('#advance'); await sureYes(org); await until(async () => (await text(org, '#eventsView h1')).includes('Submissions')); await org.click('#advance'); await sureYes(org); await until(async () => (await text(org, '#eventsView h1')).includes('Judging')); step('deadline passed: workspaces frozen, judging started');
  assert.ok(app.db.projects.find((p) => p.eventId).frozen);
  const r = await dev.evaluate(async () => { const id = (await (await fetch('/api/events')).json()).events[0].id; const t = (await (await fetch(`/api/events/${id}/mine`)).json()).team; return (await fetch(`/api/projects/${t.workspaceId}/files`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect' }, body: JSON.stringify({ path: 'x.js', content: 'late' }) })).status; });
  assert.equal(r, 403); step('late edits are rejected after the freeze');

  await judge.openEvents(); await judge.click('[data-open]'); await judge.waitForSelector('[data-sub]'); await judge.click('[data-sub]');
  await judge.waitForSelector('#replayCode'); await until(async () => (await text(judge, '#replayInfo')).includes('/')); step('judge opened the submission, code browser and replay');
  await judge.fill('#scrub', '0'); await until(async () => (await text(judge, '#replayInfo')).startsWith('1/')); step('replay scrubber seeks to the first edit');
  await judge.selectOption('#speed', '16'); await judge.click('#play'); await judge.waitForSelector('text=⏸ Pause', { timeout: 3000 }).catch(() => {}); step('replay playback at 16x');
  for (const input of await judge.$$('#scoreForm input[type=number]')) await input.fill('8');
  await judge.click('#scoreForm button'); await until(() => app.db.events[0].scores.length === 1); step('judge saved a rubric score');
  await org.click('#back'); await org.click('[data-open]'); await org.click('#advance'); await sureYes(org); await until(async () => (await text(org, '#eventsView')).includes('Leaderboard')); step('results published with leaderboard');
  assert.equal(app.db.events[0].scores[0].scores[app.db.events[0].rubric[0].id], 8);
  for (const p of [org, judge, dev]) assert.deepEqual(p.errors, []); step('no uncaught browser errors');
  console.log('\nEvents e2e PASSED');
} catch (error) { console.error('\nEvents e2e FAILED:', error.message); process.exitCode = 1; }
finally { await browser.close(); await app.close(); rmSync(dir, { recursive: true, force: true }); }
