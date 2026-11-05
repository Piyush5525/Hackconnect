// Friendly launcher: reuses a server that is already running, otherwise starts one and restarts it if it ever crashes.
//   node scripts/start.mjs        (used by start-hackconnect.cmd)
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
if (existsSync(join(root, '.env'))) for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m) process.env[m[1]] ||= m[2].replace(/^['"]|['"]$/g, ''); }
const port = Number(process.env.PORT || 4173); const url = `http://localhost:${port}`;
const healthy = async () => { try { const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; } };
const openBrowser = () => { if (process.env.HACKCONNECT_NO_BROWSER || process.env.BROWSER === 'none') return; try { spawn(process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open', process.platform === 'win32' ? ['/c', 'start', '', url] : [url], { detached: true, stdio: 'ignore' }).unref(); } catch { /* open it manually */ } };

if (await healthy()) { console.log(`HackConnect is already running at ${url}. Opening it in your browser.`); openBrowser(); process.exit(0); }

let restarts = []; let stopping = false; let child = null;
const run = () => {
  child = spawn(process.execPath, [join(root, 'server.mjs')], { stdio: 'inherit', cwd: root });
  child.on('exit', (code, signal) => {
    if (stopping) return process.exit(0);
    const now = Date.now(); restarts = restarts.filter((t) => now - t < 5 * 60000); restarts.push(now);
    if (restarts.length > 10) { console.error(`\nHackConnect keeps stopping (exit ${code ?? signal}). Read the message above, fix it, then start again.`); process.exit(1); }
    console.error(`\nHackConnect stopped (exit ${code ?? signal}). Restarting in 2 seconds...`); setTimeout(run, 2000);
  });
};
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; child?.kill(signal); setTimeout(() => process.exit(0), 3000); });
run();
const wait = setInterval(async () => { if (await healthy()) { clearInterval(wait); console.log(`\nHackConnect is running at ${url}  (close this window to stop it)\n`); openBrowser(); } }, 500);
