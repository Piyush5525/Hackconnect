# Deploying HackConnect (free path: one small VPS + Caddy)

Everything below uses free/open-source software. The only cost is the machine; an always-free VM (for example Oracle Cloud Always Free, or any 1 GB VPS) is enough for a small event. A custom domain is optional but needed for HTTPS and for camera/microphone in browsers.

> **Read first:** `docs/KNOWN_ISSUES.md`. The app stores state in a single JSON file, so run **one instance only**. It is suitable for a hackathon-sized deployment, not for multi-tenant public SaaS.

## Frontend on Vercel + backend on Railway

```
browser ── https://your-app.vercel.app ──► Vercel: static frontend
              │  /api, /download, /t, /mcp, /health are rewritten (proxied) to Railway, so the login cookie stays on the Vercel address
              └─ live sockets (room sync, calls, shared editor) go straight to Railway with a one-time ticket
```

Vercel cannot carry WebSockets, and browsers refuse cross-site cookies, so the app is wired this way: ordinary requests go through Vercel's rewrites (same address, normal cookies), and only the live sockets connect to Railway directly, authenticated by a 60-second single-use ticket (`POST /api/ws-ticket`). The UI and routes are unchanged.

### A. Backend on Railway
1. Push the repo to GitHub.
2. Railway: **New Project > Deploy from GitHub repo**. It uses the `Dockerfile` and `railway.json` (1 replica, health check `/health`).
3. **Add a Volume** to the service (right-click the service canvas > Volume, or Ctrl+K > "volume") and set the mount path to `/app/.hackconnect`. Without it, every deploy wipes your data. Volumes need a paid plan (Hobby is enough).
4. **Variables** tab, add:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `HACKCONNECT_SECURE_COOKIES` | `true` |
| `HACKCONNECT_TRUST_PROXY` | `true` |
| `HACKCONNECT_LOG` | `json` |
| `HACKCONNECT_AGENT_PROVIDER` | `demo` |
| `HACKCONNECT_MASTER_KEY` | output of `openssl rand -base64 32` (set once, never change) |
| `SMTP_*`, `GITHUB_*`, `GOOGLE_*` | optional, see `docs/ENVIRONMENT.md` |

   Do not set `PORT`: Railway injects it and the app reads it.
5. **Settings > Networking > Generate Domain**, e.g. `https://hackconnect-production.up.railway.app`. Check `<address>/health`.

(Prefer Render? `render.yaml` is still provided: *New > Blueprint*, plan `starter` for the disk.)

### B. Frontend on Vercel
1. In `vercel.json` replace **every** `https://YOUR-SERVICE.up.railway.app` with the Railway address (the build refuses to run until you do). Commit and push.
2. Vercel: **Add New > Project**, import the same repo. Leave the preset as **Other**; `vercel.json` already sets the build command (`node scripts/build-frontend.mjs`) and output folder (`dist`). Deploy. You get e.g. `https://hackconnect.vercel.app`.

### C. Connect them (Railway, Variables tab, then redeploy)
| Variable | Value |
|---|---|
| `HACKCONNECT_BASE_URL` | your **Vercel** address, e.g. `https://hackconnect.vercel.app` (emailed links, sign-in callbacks, and the only site allowed to open live sockets) |
| `HACKCONNECT_API_URL` | your **Railway** address (used by the CLI bridge / VS Code extension downloads) |

Optional second site (a custom domain, preview URL): `HACKCONNECT_ALLOWED_ORIGINS=https://a.example.com,https://b.example.com`.
If you set up GitHub/Google sign-in, their callback URL is `<Vercel address>/api/auth/oauth/<provider>/callback`.

### D. First run
Open the **Vercel** address and **sign up first with your own account: the first account becomes platform admin**. Check it: `HACKCONNECT_URL=https://<vercel-address> node scripts/smoke.mjs`.

Things to know:
- **Always use the Vercel address.** Opening the Railway address directly still works (it serves its own copy of the UI), but it is a different login.
- **One backend instance only** (`numInstances: 1`): the state file belongs to one instance. Deploys restart it for a few seconds; sockets reconnect.
- **No volume = data loss.** Make sure the Railway Volume is mounted at `/app/.hackconnect` (on Render use the `starter` plan disk).
- **Backups:** the app writes a backup into the disk every 15 minutes (newest 48 kept) and self-recovers. Also enable Railway volume backups.
- **Assistant:** keep `HACKCONNECT_AGENT_PROVIDER=demo` on the server. Users connect their own Claude/Codex with "Connect your AI" (runs on their computer) or add their own API key in the model menu.
- **Run it all on one address instead** (no Vercel): deploy only the backend and skip `vercel.json`; the backend serves the UI itself and nothing else changes.
- Local check of the Vercel setup: `npm run e2e:split`.

The rest of this guide covers the self-hosted VPS option.

## 1. Prepare the server
```bash
# Debian/Ubuntu example
sudo apt update && sudo apt install -y docker.io docker-compose-plugin git
sudo usermod -aG docker $USER   # log out/in
git clone <your repo> hackconnect && cd hackconnect
```

## 2. DNS
Create an `A` record `hack.example.com -> <server IP>` (and `AAAA` if you have IPv6). Open ports **80, 443/tcp and 443/udp** in the firewall. No wildcard record is needed yet (see "Preview domain" below).

## 3. Configure
```bash
cp .env.example .env
nano .env
```
Set at least:
```
DOMAIN=hack.example.com
HACKCONNECT_SECURE_COOKIES=true
HACKCONNECT_AGENT_PROVIDER=demo        # or compatible (see ENVIRONMENT.md)
```
Never commit `.env`. Every variable is described in `docs/ENVIRONMENT.md`.

## 4. Start
```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f caddy      # watch the certificate being issued
```
Caddy obtains and renews a free Let's Encrypt certificate automatically.

## 5. Verify (post-deploy smoke test)
```bash
HACKCONNECT_URL=https://hack.example.com node scripts/smoke.mjs
curl -s https://hack.example.com/ready
```
Then open the site, **sign up first with your own account: the first account becomes platform admin**.

## 5b. Email and sign-in providers
Set the `SMTP_*` variables for real confirmation/reset emails (a free Gmail app password or Brevo account works) and `GITHUB_CLIENT_*` / `GOOGLE_CLIENT_*` for social sign-in; `HACKCONNECT_BASE_URL` must be your public https URL. See `docs/ENVIRONMENT.md`. Run `npm run check:secrets` before every commit.

## 6. Backups (do this on day one)
The app already writes a backup every 15 minutes into `.hackconnect/backups` (newest 48 kept) and self-recovers from them. You still need an **off-machine copy**:
State lives in the `hackconnect-data` volume (`/app/.hackconnect/state.json`).
```bash
# hourly cron on the host
0 * * * * cd /path/to/hackconnect && docker compose -f docker-compose.prod.yml exec -T hackconnect node scripts/backup.mjs /app/.hackconnect/backups 48
# copy off the machine (free options: rclone to any free cloud drive, or scp to another box)
```
**Restore drill** (run it once before the event): stop the app, copy a backup over `state.json` in the volume, start the app, sign in and check a workspace.

## 7. Updating
```bash
git pull && docker compose -f docker-compose.prod.yml up -d --build
```
There are no database migrations yet; the state file is forward compatible (new fields are added on load).

## 8. Optional pieces
| Feature | How (all free) | Status |
|---|---|---|
| Free AI agent | Install Ollama on the server or your laptop, `HACKCONNECT_AGENT_PROVIDER=compatible`, `HACKCONNECT_AGENT_BASE_URL=http://host.docker.internal:11434/v1` | Implemented |
| Sandbox runner | Docker on the host; mount the socket into a **separate** runner service, never into the app. Set `HACKCONNECT_RUNNER=docker`, optionally `HACKCONNECT_RUNNER_RUNTIME=runsc` (gVisor) | Implemented, **not verified on a live Docker host** |
| Voice/video | `--profile calls` starts LiveKit; set `LIVEKIT_URL/KEY/SECRET`. Token endpoint exists; the browser UI still uses P2P WebRTC | Partial |
| Local app sharing | Users install the free `cloudflared`; `hackconnect expose <port>` | Implemented (links shown to members only) |

## Preview domain (not implemented)
The spec calls for previews on an isolated wildcard origin (`*.preview.<domain>`). Today previews are the user's own Cloudflare tunnel URL, shown only to workspace members, so no user code is ever served from your origin. If you later add a proxy, it **must** run on a separate registrable domain and strip cookies.

## Managed-cloud alternative
Any container host that supports WebSockets and a persistent volume works (Fly.io, Railway, a Kubernetes cluster). Keep `1` replica, mount a volume at `/app/.hackconnect`, set the same env vars, and terminate TLS at the platform. Free tiers change often, so check current limits first.
