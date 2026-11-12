// Team hub, end to end against the real Nexconn service: two people in two browsers talk in a project channel, react,
// start a discussion thread, leave and pick up a shift handover, ask the shared assistant, and exchange direct messages
// (typing indicator + "Seen"). Needs NEXCONN_KEY / NEXCONN_SECRET (read from .env); without them the test is skipped.
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

const dir = mkdtempSync(join(tmpdir(), 'hc-e2e-hub-')); const real = console.log; console.log = () => {}; // silence the local mail outbox
const step = (m) => real(`  ✓ ${m}`); const shots = process.env.HC_SHOTS; const shot = async (page, name) => { if (shots) { await page.waitForTimeout(350); await page.screenshot({ path: join(shots, name) }); } };
const app = createApp({ root, stateFile: join(dir, 's.json'), authLimit: 1e6, autoBackupMinutes: 0 }); await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch();
try {
  const stamp = Date.now().toString(36);
  const mk = async (name, email, url = base) => { const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) page.errors.push(m.text()); }); await page.goto(url); await page.waitForSelector('#authGate'); await page.click('#authToggle'); await page.fill('#authName', name); await page.fill('#authEmail', email); await page.fill('#authPassword', 'correct-horse-battery'); await page.click('#authSubmit'); await page.waitForSelector('#authGate', { state: 'detached' }); return page; };
  const call = (page, method, path, body) => page.evaluate(async ([m, p, b]) => (await fetch('/api' + p, { method: m, headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect' }, body: b ? JSON.stringify(b) : undefined })).json(), [method, path, body]);
  const say = async (page, text) => { await page.fill('#hubInput', text); await page.press('#hubInput', 'Enter'); };
  const openHub = async (page) => { await page.click('.nav button[data-view="hub"]'); await page.waitForSelector('#hubSide .hub-item', { timeout: 30000 }); };

  const a = await mk('Maya Rao', `maya-${stamp}@example.com`); const pid = (await call(a, 'POST', '/projects', { name: 'Campus Navigator', description: 'Indoor maps and live room availability' })).id;
  const invite = await call(a, 'POST', `/projects/${pid}/invites`, { role: 'editor' }); const b = await mk('Arjun Nair', `arjun-${stamp}@example.com`, `${base}/?invite=${invite.token}`);
  await b.waitForFunction(() => window.HC?.state?.projects?.length > 0, null, { timeout: 15000 });

  await openHub(a); await a.waitForSelector('#hubMsgs .hub-empty'); assert.equal(await a.locator('#hubSide .hub-group').first().locator('.hub-item').count(), 2, 'a project starts with #general and #handover'); step('a new project gets a #general and a #handover channel');
  await openHub(b); await b.waitForSelector('#hubInput');
  await say(a, 'Pushed the room search. Can someone review **map.ts**?'); await b.waitForSelector('#hubMsgs .hub-msg:has-text("Pushed the room search")'); assert.equal(await b.locator('#hubMsgs .hub-text strong').first().textContent(), 'map.ts'); step('a channel message reaches the teammate live, with formatting');

  await b.hover('#hubMsgs .hub-msg'); await b.click('#hubMsgs .hub-msg [data-act="pick"]'); await b.click('#hubPop [data-v="r_rocket"]'); await a.waitForSelector('#hubMsgs .hub-rx:has-text("🚀")'); step('a reaction shows up for the author');
  await b.hover('#hubMsgs .hub-msg'); await b.click('#hubMsgs .hub-msg [data-act="reply"]'); await say(b, 'On it. I will also wire the occupancy badge.'); await a.waitForSelector('#hubMsgs .hub-quote:has-text("Pushed the room search")'); step('a reply quotes the message it answers');

  await a.click('#hubSide [data-act="thread"]'); await a.fill('#thName', 'API design'); await a.fill('#thTopic', 'Agree the REST shape for /rooms before midnight'); await a.click('.hc-modal [data-act="ok"]'); await a.waitForSelector('.hub-h h2:has-text("api-design")'); await say(a, 'Proposal: GET /rooms?floor=2 returns occupancy inline.');
  await b.waitForSelector('#hubSide .hub-item.unread:has-text("api-design")', { timeout: 20000 }); await b.click('#hubSide .hub-item:has-text("api-design")'); await b.waitForSelector('#hubMsgs .hub-msg:has-text("Proposal: GET /rooms")'); step('a discussion thread appears for the teammate with an unread badge');

  await a.click('#hubSide .hub-item:has-text("handover")'); await a.click('#hubMsgs [data-act="handover"]'); await a.fill('#hoDone', 'Room search works end to end. Seeded 3 floors of demo data.'); await a.fill('#hoNext', 'Wire the occupancy badge to /api/rooms. Record the demo video.'); await a.fill('#hoBlocked', 'Maps key is rate limited, use the cached tiles.'); await a.selectOption('#hoTo', { label: 'Arjun Nair' }); await a.click('.hc-modal .primary-button'); await a.waitForSelector('#hubMsgs .ho-card');
  await b.click('#hubSide .hub-item:has-text("handover")'); await b.waitForSelector('#hubMsgs .ho-card:has-text("Seeded 3 floors")'); await b.click('#hubMsgs .ho-card [data-act="react"]'); await a.waitForSelector('#hubMsgs .ho-acks:has-text("Picked up by Arjun Nair")'); step('a handover is posted as a card and the teammate picks it up');
  await shot(a, 'hub-handover.png');

  await a.click('#hubSide .hub-item:has-text("general")'); await b.click('#hubSide .hub-item:has-text("general")'); await b.waitForSelector('#hubAside .ho-mini:has-text("Seeded 3 floors")'); step('the latest handover is summarised beside every project channel');
  await say(a, '@ai what should we build first?'); await a.waitForSelector('#hubMsgs .hub-msg.from-ai .chip:has-text("AI")', { timeout: 30000 }); await b.waitForSelector('#hubMsgs .hub-msg.from-ai:has-text("asked by Maya Rao")', { timeout: 30000 }); await b.waitForSelector('#hubMsgs .hub-msg:has-text("what should we build first")'); step('the shared assistant answers in the channel and both people see the question and the answer');
  await a.waitForFunction(() => !document.querySelector('#hubMsgs .hub-text.typing'), null, { timeout: 15000 }); await shot(a, 'hub.png');

  await a.click('#hubSide .hub-item.dm:has-text("Arjun Nair")'); await a.waitForSelector('.hub-h h2:has-text("Arjun Nair")'); await b.click('#hubSide .hub-item.dm:has-text("Maya Rao")'); await b.waitForSelector('.hub-h h2:has-text("Maya Rao")');
  await b.locator('#hubInput').pressSequentially('are you'); await a.waitForSelector('#hubTyping:has-text("Arjun Nair is typing")', { timeout: 10000 }); step('a direct message shows a typing indicator');
  await b.fill('#hubInput', 'Are you free for a 5 minute call before the demo?'); await b.press('#hubInput', 'Enter'); await a.waitForSelector('#hubMsgs .hub-msg:has-text("5 minute call")'); await b.waitForSelector('#hubMsgs .hub-seen', { timeout: 15000 }); step('a direct message is delivered and marked Seen');
  await shot(b, 'hub-dm.png');

  for (const page of [a, b]) assert.deepEqual(page.errors, [], 'no page errors and nothing blocked by the content security policy');
  step('no page errors, and the security policy allows the messaging service');
  real('Team hub e2e passed');
} finally { await browser.close(); await app.close(); }
