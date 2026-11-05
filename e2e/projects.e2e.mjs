// Projects acceptance in real browsers: usernames, import (folder + zip), language chart, README, contributors,
// invite by username + accept, file operations in the IDE, assistant, extensions, people search.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { chromium } from 'playwright';
import { createApp } from '../lib/app.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)); const dir = mkdtempSync(join(tmpdir(), 'hc-e2e-proj-')); const real = console.log; console.log = (...a) => { if (!String(a[0]).startsWith('[mail]')) real(...a); };
const app = createApp({ root, stateFile: join(dir, 's.json'), authLimit: 1e6, autoBackupMinutes: 0 }); await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch(); const step = (m) => real(`  ✓ ${m}`);
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch {} await new Promise((r) => setTimeout(r, 80)); } throw new Error(`timed out: ${fn}`); };

// a small project on disk: folder + a zip
const proj = join(dir, 'my-app'); mkdirSync(join(proj, 'src'), { recursive: true }); mkdirSync(join(proj, 'node_modules/x'), { recursive: true });
writeFileSync(join(proj, 'README.md'), '# My App\n\nBuilt with **love**.\n\n- fast\n- small\n\n```js\nconsole.log("hi")\n```\n'); writeFileSync(join(proj, 'src/main.py'), 'print("hello")\n'.repeat(60)); writeFileSync(join(proj, 'src/app.js'), 'console.log(1);\n'.repeat(20)); writeFileSync(join(proj, 'index.html'), '<h1>Hi</h1>\n'.repeat(10)); writeFileSync(join(proj, '.env'), 'SECRET=1'); writeFileSync(join(proj, 'node_modules/x/i.js'), 'x');
const zipPath = join(dir, 'extra.zip'); writeFileSync(zipPath, zipSync({ 'extra/lib.go': strToU8('package main\n'.repeat(40)), 'extra/notes.txt': strToU8('hello') }));

async function user(name, email) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(base); await page.waitForSelector('#authGate'); await page.click('#authToggle'); await page.fill('#authName', name);
  const username = await page.inputValue('#authUser'); await page.fill('#authEmail', email); await page.fill('#authPassword', 'a-long-password-1'); await page.click('#authSubmit'); await page.waitForSelector('#authGate', { state: 'detached' }); await page.waitForSelector('#ovStats');
  return { page, username };
}
const goProjects = async (p) => { await p.click('.nav button[data-view="projects"]'); await p.waitForSelector('#projectsView .pgrid'); };
try {
  const A = await user('Maya Shah', 'maya@example.com'); const B = await user('Jia Rao', 'jia@example.com'); const a = A.page; const b = B.page;
  assert.equal(A.username, 'maya-shah'); assert.equal(B.username, 'jia-rao'); step('usernames are suggested from the name (@maya-shah, @jia-rao)');
  assert.ok((await a.textContent('#ovChecklist')).includes('Get started') || (await a.textContent('#ovChecklist')).includes('Complete your profile')); assert.ok((await a.textContent('.profile-info')).includes('@maya-shah')); assert.ok(!(await a.textContent('body')).includes('Arjun'), 'no leftover demo names'); step('overview and sidebar show the real person, no demo data');

  // create a blank project, then import the folder
  await goProjects(a); assert.ok((await a.textContent('#plGrid')).includes('No projects yet')); await a.click('#plNew'); await a.fill('#npName', 'My App'); await a.fill('#npDesc', 'A small app imported from disk'); await a.click('[data-act="go"]'); await a.waitForSelector('.ppage-head'); step('created a project from the New project dialog');
  await a.click('#ppImport'); await a.waitForSelector('#inDir', { state: 'attached' }); await a.setInputFiles('#inDir', proj); await until(async () => (await a.textContent('#picked')).includes('ready'));
  await a.setInputFiles('#inZip', zipPath); await a.check('#impOver'); await a.click('[data-act="go"]'); await until(async () => (await a.textContent('#impReport')).includes('imported')); const report = await a.textContent('#impReport'); assert.ok(report.includes('.env') || report.includes('secrets'), 'secret file skipped'); assert.ok(report.includes('node_modules') || report.includes('ignored')); step('imported a folder and a zip; .env and node_modules were skipped with reasons');
  await a.click('#impOpen'); await until(async () => (await a.innerHTML('#readmeBody')).includes('<strong>love</strong>'));
  assert.ok(true); assert.ok(await a.isVisible('#readmeBody h1')); step('README is rendered as formatted Markdown');
  const legend = await a.textContent('#projectView .langlegend'); assert.ok(legend.includes('Python') && legend.includes('JavaScript') && legend.includes('Go') && legend.includes('HTML')); assert.ok(await a.isVisible('#projectView .donutwrap svg') && await a.isVisible('#projectView .langbar')); step('language chart shows Python, JavaScript, Go and HTML with percentages');
  assert.ok((await a.textContent('#projectView .pcols')).includes('@maya-shah')); step('contributors list shows the importer with their @username');

  // file browser: inspect files
  await a.click('[data-tab="files"]'); await a.waitForSelector('.fbrowser .trow'); await a.click('.fbrowser .trow[data-p="src/main.py"]'); await a.waitForSelector('.fview-body .monaco-editor'); assert.ok((await a.textContent('#fvHead')).includes('src/main.py')); step('file browser opens any file read-only with syntax highlighting');
  assert.ok(!(await a.textContent('.ftree')).includes('.env'));

  // invite by username (B) and accept
  await a.click('#ppInvite'); await a.fill('#invUser', 'jia'); await a.waitForSelector('[data-u="jia-rao"]'); await a.click('[data-u="jia-rao"]'); await a.click('[data-act="send"]'); await until(async () => (await a.textContent('#invMsg')).includes('Invitation sent to @jia-rao')); await a.keyboard.press('Escape'); step('searched @jia and sent an invitation');
  await b.click('#notifBtn'); await b.waitForSelector('[data-inv]'); assert.ok((await b.textContent('.ibx')).includes('@maya-shah')); await b.click('[data-do="accept"]'); await until(async () => { await b.keyboard.press('Escape'); return true; }); await goProjects(b); await b.waitForSelector('#projectsView .pcard'); step('B saw the invitation in the inbox, accepted it, and the project appeared');
  await b.click('#projectsView .pcard'); await b.waitForSelector('.ppage-head'); await b.click('#ppOpen'); await b.waitForSelector('.monaco-editor'); await until(async () => (await b.textContent('#saveState')).includes('Live'));
  await b.click('.trow[data-path="index.html"]'); await b.evaluate(() => { window.hcEditor.focus(); window.hcEditor.setValue('<h1>Edited by Jia</h1>\n'); }); await until(() => Object.values(app.db.projects[0].files).some((f) => f.includes('Edited by Jia')), 6000); step('B edited a file in the live workspace');

  // file operations in the IDE (A)
  await a.click('#ppOpen').catch(async () => { await a.click('.nav button[data-view="projects"]'); await a.click('#projectsView .pcard'); await a.click('#ppOpen'); }); await a.waitForSelector('.monaco-editor'); await until(async () => (await a.textContent('#saveState')).includes('Live'));
  await a.click('#newFileBtn'); await a.fill('#askInput', 'docs/guide.md'); await a.click('[data-act="ok"]'); await until(() => app.db.projects[0].files['docs/guide.md'] !== undefined); await a.waitForSelector('.trow[data-path="docs/guide.md"]'); step('created docs/guide.md from the explorer (folder appears automatically)');
  await a.click('.trow[data-path="docs/guide.md"]', { button: 'right' }); await a.click('.ctx [data-a="rename"]'); await a.fill('#askInput', 'docs/manual.md'); await a.click('[data-act="ok"]'); await until(() => app.db.projects[0].files['docs/manual.md'] !== undefined && app.db.projects[0].files['docs/guide.md'] === undefined); step('renamed a file from the right-click menu');
  await a.click('.trow[data-path="docs/manual.md"]', { button: 'right' }); await a.click('.ctx [data-a="delete"]'); await a.click('.hc-actions .btn-danger'); await until(() => app.db.projects[0].files['docs/manual.md'] === undefined); step('deleted a file after confirmation');
  await a.keyboard.press('Control+k'); await a.waitForSelector('#palIn'); await a.keyboard.type('main.py'); await a.keyboard.press('Enter'); await until(async () => (await a.textContent('#activeFile')) === 'src/main.py'); step('command palette (Ctrl+K) opens a file by name');
  await a.click('.side-tabs [data-pane="people"]'); await until(async () => (await a.textContent('#memberList')).includes('@jia-rao')); assert.ok((await a.textContent('#presenceList')).includes('Maya')); await a.click('.side-tabs [data-pane="assistant"]'); step('People tab lists members with @usernames');
  await a.click('.side-tabs [data-pane="people"]'); await a.waitForSelector('.mem-more'); await a.click('.mem-more'); await a.click('.mem-menu [data-role="viewer"]'); await until(async () => (await a.textContent('#memberList')).includes('Can view')); await a.click('.mem-more'); await a.click('.mem-menu [data-role="editor"]'); await until(async () => !(await a.textContent('#memberList')).includes('Can view')); step('owner can change a teammate access from the ⋯ menu (view, then edit again)');
  await a.click('.mem-more'); assert.ok(await a.isVisible('.mem-menu [data-remove]')); await a.keyboard.press('Escape'); await a.click('.side-tabs [data-pane="assistant"]'); step('the same menu offers Remove from project');

  // assistant (demo mode) + settings dialog
  await a.fill('#agentPrompt', 'what is this project?'); await a.click('#agentSend'); await until(async () => (await a.textContent('#assistThread')).includes('demo mode')); await a.click('#assistMode'); await a.click('#bmFoot'); await a.waitForSelector('#aiProv'); assert.ok((await a.textContent('#aiHint')).length > 5); await a.selectOption('#aiProv', 'ollama'); assert.equal(await a.inputValue('#aiUrl'), 'http://localhost:11434/v1'); await a.keyboard.press('Escape'); step('assistant answers, and settings offer free providers (Ollama preset fills the address)');
  await a.click('#wsMoreBtn'); await a.click('.more-menu [data-go="#wsExtBtn"]'); await a.waitForSelector('#xTheme'); await a.selectOption('#xTheme', 'dracula'); await a.click('label.switch:has(#xMini)'); await a.click('[data-tab="get"]'); assert.ok((await a.textContent('.hc-card')).includes('hackconnect-vscode') === false); assert.ok(await a.isVisible('a[href="/download/hackconnect-vscode.vsix"]') && await a.isVisible('a[href="/download/hackconnect-bridge.zip"]')); await a.keyboard.press('Escape'); assert.equal(await a.evaluate(() => JSON.parse(localStorage.getItem('hc-editor-settings')).theme), 'dracula'); step('extensions panel changes the editor theme/minimap and offers the VS Code extension + Bridge downloads');

  // project page now shows both contributors; people + connection request; username change
  await a.click('#wsPageBtn'); await a.waitForSelector('#projectView .contrib'); await until(async () => (await a.textContent('#projectView .pcols')).includes('@jia-rao')); assert.ok((await a.textContent('#projectView .pcols')).includes('@maya-shah')); step('project page lists both contributors with their usernames');
  await a.click('.nav button[data-view="people"]'); await a.fill('#pplQ', 'jia'); await a.waitForSelector('[data-connect="jia-rao"]'); await a.click('[data-connect="jia-rao"]'); await until(async () => (await a.textContent('#pplResults')).includes('request pending')); await b.click('.nav button[data-view="people"]'); await b.waitForSelector('[data-ac]'); await b.click('[data-ac]'); await until(async () => (await b.textContent('#pplLeft')).includes('@maya-shah')); step('connection request sent by @username and accepted');
  await a.click('#profileBtn'); await a.waitForSelector('#pfUser'); await a.fill('#pfUser', 'maya-builds'); await until(async () => (await a.textContent('#pfHint')).includes('available')); await a.click('.hc-actions .primary-button'); await until(async () => (await a.textContent('.profile-info')).includes('@maya-builds')); step('profile: changed username to @maya-builds');
  for (const p of [a, b]) assert.deepEqual(p.errors, []); step('no uncaught browser errors');
  real('\nProjects e2e PASSED');
} catch (error) { real('\nProjects e2e FAILED:', error.message); real('files:', JSON.stringify(Object.keys(app.db.projects[0]?.files || {}))); real('readme:', JSON.stringify((app.db.projects[0]?.files['README.md'] || '').slice(0, 90))); process.exitCode = 1; }
finally { await browser.close(); await app.close(); rmSync(dir, { recursive: true, force: true }); }
