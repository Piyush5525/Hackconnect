#!/usr/bin/env node
// hackconnect — Local Bridge CLI.  Nothing leaves this machine unless you run `share` or `expose`.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { BridgeSync } from './sync.mjs';
import { cloudflaredProvider } from './tunnel.mjs';

const CONFIG_DIR = process.env.HACKCONNECT_CONFIG_DIR || join(homedir(), '.hackconnect'); const CONFIG = join(CONFIG_DIR, 'config.json');
const loadConfig = () => { try { return JSON.parse(readFileSync(CONFIG, 'utf8')); } catch { return {}; } };
const saveConfig = (c) => { mkdirSync(CONFIG_DIR, { recursive: true }); writeFileSync(CONFIG, JSON.stringify(c, null, 2)); try { chmodSync(CONFIG, 0o600); } catch { /* not supported on Windows */ } };

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); if (v !== undefined) out[k] = v; else if (argv[i + 1] && !argv[i + 1].startsWith('--') && ['server', 'workspace', 'agent', 'visibility'].includes(k)) out[k] = argv[++i]; else out[k] = true; } else out._.push(a); }
  return out;
}
const die = (m) => { console.error(`✖ ${m}`); process.exit(1); };
async function http(server, path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${server}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({})); return { status: res.status, body: json };
}
const HELP = `hackconnect — share a local project with your HackConnect workspace

  hackconnect login [--server URL]
  hackconnect share [path] --workspace ID [--agent NAME] [--yes] [--allow-secrets] [--allow-sensitive]
  hackconnect expose <port> --workspace ID
  hackconnect workspaces
  hackconnect assistant [--origin URL] [--port 47831]   use your signed-in Claude Code / Codex in the HackConnect assistant
  hackconnect status | logout | terminal

Privacy: only files you share are synced; .gitignore and .hackconnectignore are honoured; .env*, keys,
node_modules and anything that looks like a secret are never uploaded unless you explicitly allow it.
Agent prompts and conversations are never captured. Press Ctrl+C to stop sharing at any time.`;

async function login(args) {
  const cfg = loadConfig(); const server = (args.server || cfg.server || 'http://localhost:4173').replace(/\/+$/, '');
  const start = await http(server, '/api/device/start', { method: 'POST', body: {} }); if (start.status !== 200) die(`Could not reach ${server} (${start.status})`);
  const { deviceCode, userCode } = start.body; const url = `${server}/?device=${userCode}`;
  console.log(`\nOpen this link while signed in to HackConnect and approve the code:\n\n  ${url}\n\n  Code: ${userCode}\n`);
  const canOpen = process.stdout.isTTY && !process.env.HACKCONNECT_NO_BROWSER && process.env.BROWSER !== 'none'; // never pop windows from scripts, CI or tests
  if (canOpen) try { spawn(process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open', process.platform === 'win32' ? ['/c', 'start', '', url] : [url], { detached: true, stdio: 'ignore' }).unref(); } catch { /* user can open the link manually */ }
  for (let i = 0; i < 300; i++) {
    await new Promise((r) => setTimeout(r, 2000)); const r = await http(server, '/api/device/token', { method: 'POST', body: { deviceCode } });
    if (r.status === 200) { saveConfig({ server, token: r.body.token }); const me = await http(server, '/api/auth/me', { token: r.body.token }); console.log(`✔ Signed in as ${me.body.user?.name || 'you'}. Next: hackconnect workspaces`); return; }
    if (r.status === 410) die('The code expired. Run login again.');
  }
  die('Timed out waiting for approval.');
}

function needAuth(args) { const cfg = loadConfig(); const server = (args.server || cfg.server || '').replace(/\/+$/, ''); if (!cfg.token || !server) die('Not signed in. Run: hackconnect login'); return { server, token: cfg.token }; }

async function share(args) {
  const { server, token } = needAuth(args); const dir = resolve(args._[1] || '.'); if (!existsSync(dir)) die(`Folder not found: ${dir}`);
  const workspaceId = args.workspace; if (!workspaceId) die('Choose a workspace: hackconnect share --workspace <id>   (see: hackconnect workspaces)');
  const me = await http(server, '/api/auth/me', { token }); if (me.status !== 200) die('Your login expired. Run: hackconnect login');
  const ws = await http(server, `/api/projects/${encodeURIComponent(workspaceId)}`, { token }); if (ws.status !== 200) die(`Workspace not found or no access (${ws.status})`);
  if (ws.body.project.role === 'viewer') die('You are a viewer in that workspace; sharing needs editor access.');
  if (!args.yes) {
    console.log(`\nYou are about to share:\n  folder:    ${dir}\n  workspace: ${ws.body.project.name} (${workspaceId})\n  as:        ${args.agent ? `agent edits (${args.agent})` : 'your own edits'}\n\nTeammates in that workspace will see these files live. .env files, keys, node_modules and detected secrets are excluded.`);
    const rl = createInterface({ input: process.stdin, output: process.stdout }); const answer = (await rl.question('Start sharing? [y/N] ')).trim().toLowerCase(); rl.close(); if (answer !== 'y' && answer !== 'yes') { console.error('Cancelled. Nothing was shared.'); process.exitCode = 1; return; } // no process.exit(): it can crash on Windows right after readline closes a piped stdin
  }
  const log = (m) => console.log(`  ${m}`);
  const sync = new BridgeSync({ dir, server, token, workspaceId, agent: args.agent || '', allowSecrets: Boolean(args['allow-secrets']), allowSensitive: Boolean(args['allow-sensitive']), log, onStatus: (s) => { if (s === 'sharing') console.log(`\n● SHARING  ${dir}  →  ${ws.body.project.name}   (Ctrl+C to stop)\n`); else if (s === 'reconnecting') console.log('◌ Reconnecting… your local changes are kept and will sync.'); } });
  sync.start();
  const stop = () => { sync.stop(); console.log('\n○ Sharing stopped. Your files stay on your machine; nothing more will be uploaded.'); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

async function expose(args) {
  const { server, token } = needAuth(args); const port = Number(args._[1]); if (!(port > 0 && port < 65536)) die('Usage: hackconnect expose <port> --workspace ID'); if (!args.workspace) die('Missing --workspace ID');
  console.log(`Opening an outbound-only tunnel to http://127.0.0.1:${port} …`);
  const tunnel = await cloudflaredProvider().open({ port }).catch((e) => die(e.message));
  const reg = await http(server, `/api/projects/${encodeURIComponent(args.workspace)}/tunnels`, { method: 'POST', token, body: { port, url: tunnel.url } });
  if (reg.status !== 201) { tunnel.close(); die(`Could not register the tunnel: ${reg.body.error || reg.status}`); }
  console.log(`\n● EXPOSED  localhost:${port}  →  ${tunnel.url}\n  Visible only to members of the workspace (private by default). Ctrl+C to close.\n`);
  const stop = async () => { tunnel.close(); await http(server, `/api/projects/${encodeURIComponent(args.workspace)}/tunnels/${reg.body.id}`, { method: 'DELETE', token }).catch(() => {}); console.log('\n○ Tunnel closed.'); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

const args = parseArgs(process.argv.slice(2)); const cmd = args._[0];
if (!cmd || cmd === 'help' || args.help) console.log(HELP);
else if (cmd === 'login') await login(args);
else if (cmd === 'logout') { rmSync(CONFIG, { force: true }); console.log('✔ Signed out. The token on this machine was deleted.'); }
else if (cmd === 'status') { const c = loadConfig(); console.log(c.token ? `Signed in to ${c.server}` : 'Not signed in'); }
else if (cmd === 'workspaces') { const { server, token } = needAuth(args); const r = await http(server, '/api/bootstrap', { token }); if (r.status !== 200) die('Login expired. Run: hackconnect login'); for (const p of r.body.projects) console.log(`${p.id}\t${p.role}\t${p.name}`); }
else if (cmd === 'assistant') { const { startAgentBridge, DEFAULT_PORT } = await import('./agent-bridge.mjs'); const origin = args.origin || process.env.HACKCONNECT_ORIGIN || loadConfig().server || 'http://localhost:4173'; await startAgentBridge({ origins: [origin], port: Number(args.port) || DEFAULT_PORT }).catch((e) => die(e.message.includes('EADDRINUSE') ? 'The assistant bridge is already running (port in use).' : e.message)); console.log('Keep this window open while you use the assistant. Press Ctrl+C to stop.'); }
else if (cmd === 'share') await share(args);
else if (cmd === 'expose') await expose(args);
else if (cmd === 'terminal') die('Terminal mirroring is not implemented yet (see docs/KNOWN_ISSUES.md).');
else die(`Unknown command "${cmd}". Try: hackconnect help`);
