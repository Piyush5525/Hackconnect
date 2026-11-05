// Generates the README screenshots (docs/screenshots/*.png) from the real running app.
// It starts a throwaway instance with a temporary state file, so none of your own data is ever captured.
//   node scripts/readme-shots.mjs
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createApp } from '../lib/app.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)); const out = join(root, 'docs', 'screenshots'); mkdirSync(out, { recursive: true });
const real = console.log; console.log = (...a) => { if (!String(a[0]).startsWith('[mail]')) real(...a); };
const dir = mkdtempSync(join(tmpdir(), 'hc-readme-')); const app = createApp({ root, stateFile: join(dir, 's.json'), authLimit: 1e6, autoBackupMinutes: 0 });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const DAY = 86400000; const shot = async (page, name, opts = {}) => { await page.waitForTimeout(opts.wait ?? 700); await page.screenshot({ path: join(out, `${name}.png`), ...opts.shot }); real(`  saved ${name}.png`); };

const newUser = async (name, email, url = base, viewport = { width: 1440, height: 900 }) => {
  const ctx = await browser.newContext({ viewport, permissions: ['microphone', 'camera'] }); const page = await ctx.newPage(); await page.addInitScript(() => { const st = document.createElement('style'); st.textContent = '#verifyBanner{display:none!important}'; document.addEventListener('DOMContentLoaded', () => document.head.appendChild(st)); }); await page.goto(url); await page.waitForSelector('#authGate');
  if (url === base && viewport.width > 1000) { await page.waitForTimeout(1000); await page.screenshot({ path: join(out, 'signin.png') }); }
  await page.click('#authToggle'); await page.fill('#authName', name); await page.fill('#authEmail', email); await page.fill('#authPassword', 'correct-horse-battery'); await page.click('#authSubmit'); await page.waitForSelector('#authGate', { state: 'detached' }); return page;
};
const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => (await fetch('/api' + p, { method: m, headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect' }, body: b ? JSON.stringify(b) : undefined })).json(), [method, path, body]);

const files = [
  { path: 'README.md', content: '# Campus Navigator\n\nIndoor maps and live room availability for a university campus.\n\n- Search any room, lab or office\n- Live occupancy from the timetable\n- Works offline after the first visit\n' },
  { path: 'src/App.tsx', content: "import { useEffect, useState } from 'react';\nimport { searchRooms, type Room } from './map';\n\nexport function App() {\n  const [query, setQuery] = useState('');\n  const [rooms, setRooms] = useState<Room[]>([]);\n\n  useEffect(() => {\n    searchRooms(query).then(setRooms);\n  }, [query]);\n\n  return (\n    <main className=\"app\">\n      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder=\"Find a room\" />\n      <ul>{rooms.map((r) => <li key={r.id}>{r.name} · floor {r.floor}</li>)}</ul>\n    </main>\n  );\n}\n" },
  { path: 'src/map.ts', content: "export interface Room { id: string; name: string; floor: number; free: boolean }\n\nconst ROOMS: Room[] = [\n  { id: 'a101', name: 'Algorithms Lab', floor: 1, free: true },\n  { id: 'b204', name: 'Seminar Hall B', floor: 2, free: false },\n  { id: 'c012', name: 'Robotics Studio', floor: 0, free: true },\n];\n\nexport async function searchRooms(query: string): Promise<Room[]> {\n  const q = query.trim().toLowerCase();\n  return ROOMS.filter((r) => r.name.toLowerCase().includes(q));\n}\n" },
  { path: 'styles.css', content: '.app { display: grid; gap: 12px; max-width: 520px; margin: 40px auto; font-family: system-ui, sans-serif; }\n.app input { padding: 10px 12px; border: 1px solid #ccd; border-radius: 8px; }\n' },
  { path: 'package.json', content: '{\n  "name": "campus-navigator",\n  "private": true,\n  "scripts": { "dev": "vite", "build": "vite build" },\n  "dependencies": { "react": "^18.3.0", "react-dom": "^18.3.0" }\n}\n' }
];

try {
  real('Creating the sample team...');
  const maya = await newUser('Maya Rao', 'maya@example.com');
  const projectId = (await api(maya, 'POST', '/projects', { name: 'Campus Navigator', description: 'Indoor maps and live room availability for a university campus' })).id;
  await api(maya, 'POST', `/projects/${projectId}/import`, { overwrite: true, files });
  const ecoId = (await api(maya, 'POST', '/projects', { name: 'Eco Tracker', description: 'Track and reduce your carbon footprint with friends' })).id;
  await api(maya, 'POST', `/projects/${ecoId}/import`, { overwrite: true, files: [{ path: 'README.md', content: '# Eco Tracker\n\nLog daily habits and see your impact.\n' }, { path: 'main.py', content: 'def footprint(km, kwh):\n    return km * 0.12 + kwh * 0.4\n' }] });
  const inv1 = await api(maya, 'POST', `/projects/${projectId}/invites`, { role: 'editor' }); const inv2 = await api(maya, 'POST', `/projects/${projectId}/invites`, { role: 'editor' });
  const arjun = await newUser('Arjun Nair', 'arjun@example.com', `${base}/?invite=${inv1.token}`); const sara = await newUser('Sara Khan', 'sara@example.com', `${base}/?invite=${inv2.token}`);
  for (const [who, text] of [[arjun, 'Pushed the room search, can someone review map.ts?'], [sara, 'On it. I will also wire the occupancy badge.'], [maya, 'Great. Jump in the call at 5 and we will demo it.']]) await api(who, 'POST', `/projects/${projectId}/messages`, { text });
  for (const t of [['Smart India Hackathon 2026', 'building', 3 * DAY], ['Google Solution Challenge', 'registered', 18 * DAY], ['ETHGlobal Online', 'interested', 40 * DAY]]) await api(maya, 'POST', '/me/hackathons', { name: t[0], status: t[1], deadline: Date.now() + t[2], platform: 'manual' });
  const ev = await api(maya, 'POST', '/events', { title: 'Build for Bharat Hackathon', description: 'A 36 hour build sprint for campus and civic tools.', tracks: ['Campus', 'Civic', 'Open'], maxTeamSize: 4, deadline: Date.now() + 2 * DAY });
  await api(maya, 'PATCH', `/events/${ev.id}`, { status: 'registration' }); await api(arjun, 'POST', `/events/${ev.id}/register`, {});

  real('Capturing screens...');
  await maya.reload(); await maya.waitForSelector('.hk-card'); await shot(maya, 'overview', { wait: 1200 });
  await maya.evaluate(() => document.querySelector('[data-view="projects"]').click()); await maya.waitForSelector('#projectsView .pcard'); await shot(maya, 'projects', { wait: 900 });
  await maya.evaluate(() => document.querySelector('[data-view="events"]').click()); await shot(maya, 'hackathons', { wait: 900 });
  await maya.evaluate(() => document.querySelector('[data-view="tracker"]')?.click()); await shot(maya, 'my-hackathons', { wait: 900 });
  await maya.evaluate(() => document.querySelector('[data-view="activity"]').click()); await shot(maya, 'activity', { wait: 900 });

  for (const p of [maya, arjun, sara]) { await p.evaluate((id) => window.HackConnectApp.openProject(id), projectId); await p.waitForSelector('.monaco-editor'); }
  await maya.waitForFunction(() => document.querySelector('#saveState')?.textContent.includes('Live')); await maya.waitForTimeout(800);
  await maya.locator('.file-panel').getByText('App.tsx').first().click(); await maya.waitForTimeout(800); await maya.click('.side-tabs [data-pane="chat"]'); await maya.waitForTimeout(600); await shot(maya, 'workspace');
  await maya.evaluate(() => document.querySelector('#wsMoreBtn')?.click()); await shot(maya, 'workspace-menu', { wait: 500 }); await maya.keyboard.press('Escape'); await maya.mouse.click(10, 10);

  // a call with three people + invite + volume menu
  for (const p of [maya, arjun, sara]) await p.evaluate(() => window.HC.call.join(window.HC.state.currentProject.id, 'general'));
  await maya.waitForFunction(() => window.HC.call.state.peers.size === 2, null, { timeout: 20000 }); await maya.waitForTimeout(1000); await shot(maya, 'call-dock');
  await maya.click('#callDock [data-a="expand"]'); await maya.waitForSelector('#callStage.full'); await shot(maya, 'call-fullscreen', { wait: 1200 });
  await maya.locator('#callStage .ct:not([data-id="self"])').first().click({ button: 'right' }); await maya.waitForSelector('.vol-menu'); await shot(maya, 'call-volume-menu', { wait: 600 }); await maya.keyboard.press('Escape');
  await maya.click('#callStage [data-a="invite"]'); await maya.waitForSelector('.inv-pop'); await shot(maya, 'call-invite', { wait: 600 }); await maya.keyboard.press('Escape');
  await maya.click('#callStage [data-a="leave"]'); await arjun.evaluate(() => window.HC.call.leave()); await sara.evaluate(() => window.HC.call.leave());
  // inbox with the "join the call" message
  await maya.evaluate(() => document.querySelector('[data-view="overview"]').click()); await maya.evaluate((id) => window.HackConnectApp.openProject(id), projectId);
  await maya.evaluate(() => window.HC.call.join(window.HC.state.currentProject.id, 'general')); await maya.waitForSelector('#callDock'); await maya.click('#callDock [data-a="invite"]'); await maya.waitForSelector('.inv-pop .inv-row'); await maya.click('#invSend'); await maya.waitForTimeout(500); await maya.evaluate(() => window.HC.call.leave());
  await sara.evaluate(() => document.querySelector('[data-view="overview"]').click()); await sara.waitForSelector('.call-invite', { timeout: 20000 }).catch(() => {}); await sara.click('#notifBtn'); await sara.waitForSelector('.ibx .ibx-join'); await shot(sara, 'inbox-call-invite', { wait: 700 });

  const phone = await newUser('Phone View', 'phone@example.com', base, { width: 390, height: 800 }); await phone.evaluate(() => document.querySelector('[data-view="projects"]').click()); await shot(phone, 'mobile', { wait: 900 });
  real('Done: docs/screenshots');
} finally { await browser.close(); await app.close(); rmSync(dir, { recursive: true, force: true }); }
