#!/usr/bin/env node
// HackConnect assistant bridge: lets the in-browser assistant use the Claude Code / Codex command-line tools
// that are already signed in on THIS computer. No passwords or API keys ever go through HackConnect:
// the CLI signs in with its own browser flow, and the prompt is run locally by that CLI.
//
// Security model
//  - listens on 127.0.0.1 only
//  - every request must come from the HackConnect origin(s) you allow (browser Origin header) and use a localhost Host
//    header (blocks other websites and DNS-rebinding)
//  - the CLI runs in an empty temporary folder, so it cannot read your files, and arguments are fixed (the prompt goes via stdin)
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_PORT = 47831;
const IS_WIN = process.platform === 'win32';
const MAX_PROMPT = 400_000; const MAX_OUT = 600_000; const RUN_TIMEOUT = 180_000;
// Fixed command lines. {prompt} is always sent on stdin, never interpolated.
const TOOLS = {
  claude: { label: 'Claude', bin: 'claude', version: ['--version'], status: ['auth', 'status'], login: ['auth', 'login'], run: ['-p'], loginHint: 'Run `claude` in a terminal and type /login.' },
  codex: { label: 'Codex', bin: 'codex', version: ['--version'], status: ['login', 'status'], login: ['login'], run: ['exec', '--skip-git-repo-check', '-'], loginHint: 'Run `codex login` in a terminal.' }
};

/** Run a CLI with fixed args. On Windows the npm shims are .cmd files, which need a shell; args are constants so this is safe. */
function runCli(tool, args, { input = '', timeout = 10_000, cwd = tmpdir(), detached = false } = {}) {
  return new Promise((resolve) => {
    let child; try { child = IS_WIN ? spawn([TOOLS[tool].bin, ...args].join(' '), { cwd, shell: true, windowsHide: true, stdio: detached ? 'ignore' : ['pipe', 'pipe', 'pipe'], detached, env: { ...process.env, NO_COLOR: '1', CI: '1' } } ) : spawn(TOOLS[tool].bin, args, { cwd, windowsHide: true, stdio: detached ? 'ignore' : ['pipe', 'pipe', 'pipe'], detached, env: { ...process.env, NO_COLOR: '1', CI: '1' } }); } catch (error) { return resolve({ ok: false, code: -1, out: '', err: error.message, missing: true }); }
    if (detached) { child.on('error', () => resolve({ ok: false, missing: true, out: '', err: '' })); child.unref(); return setTimeout(() => resolve({ ok: true, out: '', err: '' }), 400); }
    let out = ''; let err = ''; let over = false; const timer = setTimeout(() => { child.kill(); resolve({ ok: false, code: -2, out, err: 'timeout', timeout: true }); }, timeout);
    child.stdout.on('data', (d) => { out += d; if (out.length > MAX_OUT) { over = true; child.kill(); } }); child.stderr.on('data', (d) => { err += d; if (err.length > 50_000) err = err.slice(-50_000); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, code: -1, out, err: e.message, missing: true }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0 && !over, code, out: out.slice(0, MAX_OUT), err, missing: IS_WIN ? /not recognized|cannot find/i.test(err) : false }); });
    child.stdin.on('error', () => { /* CLI exited early */ }); child.stdin.end(input);
  });
}

async function toolStatus(tool) {
  const v = await runCli(tool, TOOLS[tool].version, { timeout: 8000 });
  if (!v.ok) return { installed: false, signedIn: null, version: '' };
  const s = await runCli(tool, TOOLS[tool].status, { timeout: 8000 });
  // Some CLI versions do not have a status command: then we cannot know (null) and the UI lets the user just try it.
  const unknown = /unknown|unrecognized|invalid|usage|not a valid/i.test(s.err + s.out);
  return { installed: true, signedIn: unknown ? null : s.ok, version: v.out.trim().split('\n')[0].slice(0, 60) };
}

export function startAgentBridge({ origins = [], port = DEFAULT_PORT, log = console.log } = {}) {
  const allowed = new Set(origins.map((o) => { try { return new URL(o).origin; } catch { return null; } }).filter(Boolean));
  if (!allowed.size) throw new Error('Give at least one HackConnect address with --origin (for example --origin http://localhost:4173)');
  let busy = false;
  const server = http.createServer(async (req, res) => {
    const origin = String(req.headers.origin || ''); const host = String(req.headers.host || '').toLowerCase();
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': allowed.has(origin) ? origin : 'null', vary: 'Origin', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(body)); };
    if (!new RegExp(`^(127\\.0\\.0\\.1|localhost):${port}$`).test(host)) return send(403, { error: 'Bad host' });
    if (!allowed.has(origin)) return send(403, { error: 'This website is not allowed to use the assistant bridge' });
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-allow-private-network': 'true', 'access-control-max-age': '600', vary: 'Origin' }); return res.end(); }
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/status') { const [claude, codex] = await Promise.all([toolStatus('claude'), toolStatus('codex')]); return send(200, { ok: true, version: 1, tools: { claude: { ...claude, label: TOOLS.claude.label }, codex: { ...codex, label: TOOLS.codex.label } } }); }
      if (req.method === 'POST') {
        let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > MAX_PROMPT + 5000) return send(413, { error: 'Request too large' }); }
        let body; try { body = JSON.parse(raw || '{}'); } catch { return send(400, { error: 'Invalid JSON' }); } const tool = String(body.tool || '');
        if (!TOOLS[tool]) return send(400, { error: 'Unknown tool' });
        if (url.pathname === '/login') { const r = await runCli(tool, TOOLS[tool].login, { detached: true }); return r.ok ? send(200, { started: true, hint: TOOLS[tool].loginHint }) : send(200, { started: false, error: `${TOOLS[tool].label} is not installed on this computer.`, hint: TOOLS[tool].loginHint }); }
        if (url.pathname === '/run') {
          const prompt = String(body.prompt || ''); if (!prompt.trim() || prompt.length > MAX_PROMPT) return send(400, { error: 'Prompt is empty or too large' });
          if (busy) return send(429, { error: 'The bridge is already answering another request' }); busy = true; const dir = mkdtempSync(join(tmpdir(), 'hc-assistant-'));
          try { const r = await runCli(tool, TOOLS[tool].run, { input: prompt, timeout: RUN_TIMEOUT, cwd: dir });
            if (r.missing) return send(200, { ok: false, error: `${TOOLS[tool].label} is not installed on this computer.`, code: 'missing' });
            if (r.timeout) return send(200, { ok: false, error: `${TOOLS[tool].label} took too long to answer.`, code: 'timeout' });
            if (!r.ok) { const msg = (r.err || r.out || '').trim().slice(-400); const login = /log ?in|sign ?in|auth|credential|api key|unauthorized|401/i.test(msg); return send(200, { ok: false, code: login ? 'login' : 'failed', error: login ? `${TOOLS[tool].label} is not signed in. Click “Sign in” in the assistant settings.` : `${TOOLS[tool].label} failed: ${msg || 'unknown error'}` }); }
            return send(200, { ok: true, text: r.out.trim() });
          } finally { busy = false; try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp folder */ } }
        }
      }
      return send(404, { error: 'Not found' });
    } catch (error) { return send(500, { error: error.message }); }
  });
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { log(`HackConnect assistant bridge listening on http://127.0.0.1:${port} for ${[...allowed].join(', ')}`); resolve(server); }); });
}

// Run directly: node bridge/agent-bridge.mjs --origin http://localhost:4173
if (import.meta.url === new URL(process.argv[1] || '', 'file://').href || process.argv[1]?.endsWith('agent-bridge.mjs')) {
  const args = process.argv.slice(2); const get = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
  const origins = [get('origin') || process.env.HACKCONNECT_ORIGIN || 'http://localhost:4173'];
  startAgentBridge({ origins, port: Number(get('port')) || DEFAULT_PORT }).then(() => console.log('Keep this window open while you use the assistant. Press Ctrl+C to stop.')).catch((e) => { console.error(`✖ ${e.message}`); process.exit(1); });
}
