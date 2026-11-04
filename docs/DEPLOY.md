# Deploying HackConnect (free path: one small VPS + Caddy)

Everything below uses free/open-source software. The only cost is the machine; an always-free VM (for example Oracle Cloud Always Free, or any 1 GB VPS) is enough for a small event. A custom domain is optional but needed for HTTPS and for camera/microphone in browsers.

> **Read first:** `docs/KNOWN_ISSUES.md`. The app stores state in a single JSON file, so run **one instance only**. It is suitable for a hackathon-sized deployment, not for multi-tenant public SaaS.

## Fastest path: Render (one service, no server to manage)

HackConnect is **one app**: it serves its own frontend, the API and the WebSockets from the same address, signs users in with a cookie and keeps its data in one file. So deploy it as a **single Render web service with a persistent disk**. Do **not** split the frontend onto Vercel: Vercel cannot proxy WebSockets (live editor, chat, calls) and the login cookie would not cross sites.

1. Push the repo to GitHub.
2. Render dashboard: **New > Blueprint**, pick the repo. It reads `render.yaml`: Docker build, 1 instance, a 1 GB disk at `/app/.hackconnect`, health check `/health`, secure cookies. The disk needs a paid plan (`starter`); the free plan has no disk and would lose all data on every restart.
3. Fill the prompts. Everything is optional except you will set the URL in step 4. `HACKCONNECT_MASTER_KEY` is generated for you; **never change it later**.
4. When the first deploy finishes, copy the service address (for example `https://hackconnect.onrender.com`) into `HACKCONNECT_BASE_URL` (Environment tab) and redeploy. It is used for sign-in callbacks, emailed links and the assistant launcher download.
5. Open the site and **sign up first with your own account: the first account becomes platform admin**.
6. Optional: add a custom domain in Render (it handles HTTPS), then update `HACKCONNECT_BASE_URL` and any OAuth callback URLs to match.
7. Check it: `HACKCONNECT_URL=https://<your-address> node scripts/smoke.mjs` and open `/ready`.

Things to know on Render:
- **One instance only.** Keep `numInstances: 1`; scaling out would give two copies of the state file.
- **Deploys restart the app** (a few seconds of downtime, WebSockets reconnect). Because it has a disk, Render cannot do zero-downtime swaps.
- **Backups:** the app writes a backup into the disk every 15 minutes (newest 48 kept) and recovers from it automatically. Also enable Render's disk snapshots and, before an important event, download a copy of `/app/.hackconnect/state.json` from the Render shell.
- **Assistant:** keep `HACKCONNECT_AGENT_PROVIDER=demo` on the server. Users connect their own Claude/Codex with the "Connect your AI" button (the launcher runs on their own computer), or add their own API key in the assistant's model menu.
- **Logs:** `HACKCONNECT_LOG=json` makes them easy to search in Render's log viewer.

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
Then open the site, **sign up first with your own account: the first account becomes platform admin**. Create the demo event if you want one: stop the app, run `docker compose -f docker-compose.prod.yml run --rm hackconnect node scripts/seed.mjs`, start the app.

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
