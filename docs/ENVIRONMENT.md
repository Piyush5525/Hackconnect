# Environment variables

Node does not load `.env` by itself; `server.mjs` reads it at start and never overrides variables already set in the environment. Everything is optional: with no variables set the app runs fully locally in demo-agent mode.

| Variable | Default | Purpose / where to get it |
|---|---|---|
| `PORT` | `4173` | HTTP + WebSocket port |
| `HACKCONNECT_SECURE_COOKIES` | `false` | Set `true` behind HTTPS so session cookies get `Secure` |
| `HACKCONNECT_LOG` | off | `json` prints one structured line per request (with request id, no bodies, no secrets) |
| `HACKCONNECT_METRICS_TOKEN` | none | If set, `/metrics` requires `Authorization: Bearer <token>` |
| `HACKCONNECT_AGENT_PROVIDER` | `demo` | `demo` (free, no key, canned edits), `compatible` (any OpenAI-compatible server: **Ollama is free and local**, Groq/Gemini/OpenRouter have free tiers), `openai`, `anthropic` |
| `HACKCONNECT_AGENT_MODEL` | provider default | Model name, for example `qwen2.5-coder` for Ollama |
| `HACKCONNECT_AGENT_BASE_URL` | none | For `compatible`, for example `http://localhost:11434/v1` |
| `HACKCONNECT_AGENT_API_KEY` | none | Only for hosted `compatible` services; Ollama needs none |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | none | Only for those providers (paid) |
| `HACKCONNECT_RUNNER` | off | `docker` enables `POST /api/projects/:id/run` through the hardened Docker provider |
| `HACKCONNECT_RUNNER_IMAGE` | `node:22-alpine` | Image used for runs |
| `HACKCONNECT_RUNNER_RUNTIME` | none | `runsc` to use gVisor if installed |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | none | Enables `POST /api/projects/:id/call-token`. Self-host LiveKit (Apache-2.0) or use its free cloud tier |
| `HACKCONNECT_BASE_URL` | derived from the request | Public URL of the server (for example `https://hack.example.com`). Used to build the OAuth callback. Set it in production |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | none | Enables **Continue with GitHub** and **Connect GitHub** (repo access for sync). Setup below |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | none | Enables **Continue with Google**. Setup below |
| `HACKCONNECT_MASTER_KEY` | generated file | base64 of 32 random bytes (`openssl rand -base64 32`). Encrypts stored GitHub tokens (AES-256-GCM). If unset, `.hackconnect/master.key` is created on first start: back it up with the state file or linked tokens become unreadable |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | none | Real email for confirmation and reset links (STARTTLS on 587, or implicit TLS with `SMTP_SECURE=true` on 465). Free: Gmail with an app password (smtp.gmail.com), Brevo/Sendinblue free tier, or a local Mailpit. Without it, links are printed in the server window and saved in `.hackconnect/outbox/` |
| `HACKCONNECT_REQUIRE_VERIFIED` | `true` if SMTP is set, else `false` | When true, accounts cannot sign in until the emailed link is opened |
| `HACKCONNECT_AUTOBACKUP_MIN` | `15` | Minutes between automatic state backups (`0` disables). The newest 48 stay in `.hackconnect/backups`; a damaged `state.json` is restored from the newest good one at start-up |
| `HACKCONNECT_ALLOW_PRIVATE_AI` | `true` locally, `false` when `HACKCONNECT_BASE_URL` is https | Whether users may point the assistant at private/loopback addresses such as Ollama on `localhost`. Keep `false` on a hosted server. Link-local/cloud-metadata addresses are always refused |
| `DOMAIN` | none | Used by `docker-compose.prod.yml` / Caddy |
| `HACKCONNECT_URL` | `http://127.0.0.1:4173` | Target for `scripts/smoke.mjs` |
| `HACKCONNECT_STATE` | `.hackconnect/state.json` | State file used by `scripts/seed.mjs` |
| `HACKCONNECT_CONFIG_DIR` | `~/.hackconnect` | Where the Local Bridge stores its token |
| `CLOUDFLARED` | `cloudflared` | Path to the free `cloudflared` binary used by `hackconnect expose` |

**Not used by the code:** `SERP_API` and `GITHUB_TOKEN` in a local `.env`. GitHub features use each person's own connected GitHub account (via `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`), never a server-wide token, so `GITHUB_TOKEN` can be deleted (and revoked at GitHub).

## Secrets hygiene
- `.env` is git-ignored and docker-ignored. `.env.example` must stay free of real values.
- If a real key was ever pasted into `.env.example` or committed, revoke it at the provider and issue a new one.
- API keys are read from the environment only; per-user encrypted key storage is not implemented yet (see `docs/KNOWN_ISSUES.md`).

## Accounts the owner may supply (all optional)
A GitHub OAuth app and a Google OAuth client (sign-in; GitHub also powers sync), an AI endpoint (Ollama needs nothing), LiveKit, a domain, an SMTP provider (not used yet: email verification and password reset are not implemented).

## Setting up Google and GitHub sign-in (free, about 5 minutes each)
The callback (redirect) URL is always `<HACKCONNECT_BASE_URL>/api/auth/oauth/<provider>/callback`. For local use that is `http://localhost:4173/...`. Use exactly the address you type in the browser (`localhost`, not `127.0.0.1`).

**GitHub**
1. GitHub > Settings > Developer settings > OAuth Apps > **New OAuth App**.
2. Homepage URL `http://localhost:4173`; Authorization callback URL `http://localhost:4173/api/auth/oauth/github/callback`.
3. Create the app, copy the **Client ID**, click **Generate a new client secret** and copy it.
4. Put `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in `.env`, restart the server.
Sign-in asks only for your profile and verified email. **Connections > Connect GitHub** additionally asks for the `repo` scope so "GitHub sync" can write to your repositories with *your* permissions (the token is stored encrypted).

**Google**
1. Google Cloud Console (free; no billing needed) > create a project > **APIs & Services > OAuth consent screen**: External, add your email as a test user.
2. **Credentials > Create credentials > OAuth client ID** > Web application.
3. Authorized redirect URI: `http://localhost:4173/api/auth/oauth/google/callback`.
4. Copy the client ID and secret into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, restart.
While the consent screen is in "Testing", only the test users you listed can sign in.

For production add a second redirect/callback URL with your real domain, and set `HACKCONNECT_BASE_URL`.

## AI assistant keys
People add their own provider and API key under the assistant's gear icon (Settings > Assistant). Keys are encrypted with the master key and never returned by the API. `HACKCONNECT_AGENT_*` variables are only the fallback used when a person has not configured anything.
