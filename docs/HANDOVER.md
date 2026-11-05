# HackConnect handover

## Run
```bash
npm install
npm start                 # http://localhost:4173, sign up (first account = admin). Windows: double-click start-hackconnect.cmd
npm run seed              # optional demo event (stop the server first; --force wipes state)
npm run test:all          # unit/integration (110 tests) + four real-browser acceptance scripts
npm run loadtest          # collab latency check
```
One-time for browser tests: `npx playwright install chromium`.

## Deploy
`docs/DEPLOY.md` (single VPS + Caddy, free). Env vars: `docs/ENVIRONMENT.md`. Incidents: `docs/RUNBOOK.md`. Threats: `docs/SECURITY.md`. Routes: `docs/API.md`.

## Use the Local Bridge
```bash
node bridge/cli.mjs login --server http://localhost:4173     # or: npm i -g . then `hackconnect ...`
node bridge/cli.mjs workspaces
node bridge/cli.mjs share ./my-project --workspace <id> [--agent claude-code]
node bridge/cli.mjs expose 3000 --workspace <id>             # needs free cloudflared
```

## Code map
| Path | What |
|---|---|
| `server.mjs` | Entry: loads `.env`, starts `lib/app.mjs` |
| `lib/app.mjs` | HTTP routes, sessions, CSRF, rooms, WebSocket upgrade routing |
| `lib/policy.mjs` | **All** authorization decisions (workspace, team, event) |
| `lib/collab.mjs` | Yjs documents, persistence, agent/REST writes through the CRDT |
| `lib/events.mjs`, `lib/judging.mjs` | Events, submissions, freeze, scoring, replay, signals, PDF |
| `lib/platform.mjs` | Tokens, device login, approval gate, MCP, tunnels, admin, account |
| `lib/runner.mjs` | Sandbox provider interface + Docker implementation |
| `lib/secrets.mjs` | Secret scanner + ignore rules (shared by server and Bridge) |
| `lib/social.mjs`, `lib/projects.mjs`, `lib/langs.mjs` | Usernames/requests/invites; import, overview, file ops, ZIP export; language detection |
| `lib/agent.mjs`, `lib/downloads.mjs` | AI providers + endpoint safety; generated .vsix and Bridge zip |
| `app.css`, `projects-ui.js` | Project/people/overview screens, importer, inbox, profile |
| `bridge/` | Local Bridge CLI, sync engine, tunnel provider |
| `src/collab-client.js` -> `vendor/collab-client.js` | Browser Yjs client (`npm run build:client`) |
| `index.html`, `app.js`, `events-ui.js`, `shell.js` | Original design shell + IDE workspace + Hackathons screens |
| `public/` | Logo, favicon, icons, manifest (`npm run build:icons` regenerates the PNGs) |

## How to extend
- **New permission:** add the action to `lib/policy.mjs`, add rows to `test/policy.test.mjs`, call it from the route.
- **Swap storage:** all persistence goes through the `db` object and `save()`. Replace with a repository layer + PostgreSQL migrations; the route code and tests stay.
- **Swap the sandbox:** implement `run({files, command, timeoutMs, network})` and pass it to `createApp({ runner })`.
- **Swap the tunnel:** implement `open({port}) -> {url, close()}` like `bridge/tunnel.mjs`.
- **Editor:** Monaco lives in `src/collab-client.js` (`createEditor`, `bindEditor`); `vendor/` is generated (`npm run build:client`, also run by `npm install`) and git-ignored.

## What is incomplete
See `docs/KNOWN_ISSUES.md` (14 items) and `docs/PROGRESS.md`. In short: no OAuth/email flows, no database, textarea editor, no PTY terminal or preview proxy, runner never run on live Docker, LiveKit not in the UI, GitHub App missing, CI never executed.

## Top 10 risks (status after the hardening pass)
| # | Risk | Status |
|---|---|---|
| 1 | **A real OpenAI key and GitHub token were pasted into `.env.example` earlier.** | **You must revoke both** (code cannot un-leak a key). Guard added: `npm run check:secrets` (also a test and in CI) fails if a secret appears in any committed/published file, or if `.env` is not ignored. |
| 2 | Single-file state, single process. | Mitigated: batched atomic writes, **automatic backup every 15 min** (newest 48), **self-recovery from the newest good backup** if `state.json` is damaged (refuses to start rather than overwrite if none), flush on shutdown. Still one instance only, no PITR. Take an off-machine copy (docs/DEPLOY.md). |
| 3 | Sandbox runner never run on a live Docker host. | Cannot be fixed without Docker. `npm run verify:runner` runs 11 isolation probes (no network, no metadata address, read-only FS, non-root, no capabilities, no docker socket, process/memory caps, timeout). **Run it on the target machine before enabling `HACKCONNECT_RUNNER`**; keep it off otherwise. |
| 4 | No email verification / password reset. | **Fixed:** confirmation and reset links (hashed, single-use, expiring tokens), reset signs out all devices, SMTP or local outbox, optional "verified email required" (on by default when SMTP is set), banner + resend. Add `SMTP_*` to send real mail. |
| 5 | Tunnel URLs were bearer secrets. | **Fixed:** teammates get signed, expiring, per-request-checked preview links through a sandboxed read-only proxy; the raw URL stays with its creator. Limits: no WebSockets/HMR, absolute-path apps break; for a hard lock on the raw URL use free Cloudflare Access. |
| 6 | In-memory rate limits reset on restart. | **Mitigated:** per-account lockout (5 failures = 10 min) is stored in the state file and survives restarts. The per-IP limiter is still in memory. |
| 7 | CSP allowed inline scripts. | **Fixed:** the page script moved to `shell.js`; `script-src 'self'` only (asserted by a test); all browser tests pass under it. Inline styles remain allowed. |
| 8 | Replay history capped at 2000 entries per workspace. | **Fixed:** patch-based history with periodic checkpoints, 20,000-entry cap with safe trimming (tested against a reference reconstruction), smaller state file. |
| 9 | Deadlines were manual. | **Fixed:** a 30 s scheduler warns 15 minutes before and then freezes workspaces and starts judging at `deadline` (tested with a controlled clock). Setting the deadline from the UI is not built yet (`PATCH /api/events/:id {deadline}`). |
| 10 | CI/deploy files never executed. | **Partly fixed:** `test/ci.test.mjs` validates workflow YAML, action references, every `npm run` and `node scripts/...` they call, Dockerfile COPY sources vs what the server serves, and compose/Caddy consistency. They still have not run on GitHub or a real VPS. |
