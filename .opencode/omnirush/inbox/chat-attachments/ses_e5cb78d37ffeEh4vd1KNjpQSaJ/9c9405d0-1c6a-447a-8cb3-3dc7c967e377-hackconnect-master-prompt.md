# HACKCONNECT — MASTER BUILD PROMPT

> Paste everything below this line into your coding agent. Work autonomously. Do not stop to ask questions unless a decision is truly irreversible. Make the sensible choice, record it in `docs/DECISIONS.md`, and keep going.

---

## 0. ROLE AND MISSION

You are a principal full-stack engineer and architect. Build **HackConnect** end to end: a production-ready, deployable web platform where hackathon teams **code together in real time, talk to each other, bring their own AI agents, and share what they are running**, and where organizers can **host whole hackathons** with live progress, replayable code history, and judging.

**One-line pitch:** *Google Docs + VS Code Live Share + Discord + Devpost, built for hackathons.*

**Definition of success:** a stranger can clone the repo, run `docker compose up`, open the site, sign up, create a team workspace, invite a teammate, edit the same file live, talk on voice/video, share a running app, submit to a hackathon, and a judge can replay and score it. Then the same codebase deploys to production using the guide you write. "It compiles" is not success. "It runs and I tested it" is.

**The frontend is already designed.** Do not redesign it. Phase 0 is to inspect it and wire it up. Keep its look, components, routes and design tokens. Where a screen needed by this spec is missing, build it in the same visual language.

---

## 1. THE PROBLEM (why this exists)

1. A teammate builds on their own laptop. Nobody else sees the code, the running app, or the agent output. Handoff happens through git commits and screenshots, which is slow and lossy.
2. Pairing tools are fragmented: one for code, one for calls, one for chat, one for the repo.
3. Online hackathons run on Devpost-style platforms where judges only see a final repo link and a demo video. Nobody can see *how* the project was built.
4. Teams use AI coding agents (Claude Code, Cursor, Copilot, etc.) but those run privately on one machine and are invisible to the rest of the team.

HackConnect fixes all four in one product.

---

## 2. PRODUCT SCOPE

### 2.1 Core modules (all required)

**A. Accounts & identity**
- Sign up / sign in: GitHub OAuth, Google OAuth, email + password (verified email, password reset). Magic link optional.
- Profile: name, avatar, bio, skills, GitHub handle, timezone, links.
- Roles at platform level: `user`, `admin`. Roles at event level: `organizer`, `judge`, `mentor`, `participant`. Roles at workspace level: `owner`, `editor`, `viewer`.

**B. Teams & workspaces**
- Create a team, invite by link / email / username. Join requests. Team finder ("looking for teammates" with skills).
- A **Workspace** = a shared project room (files, terminal, preview, call, chat, agents). A team can have many workspaces. A workspace may be standalone (not tied to an event) or tied to an event.
- Workspace templates: blank, Next.js, React+Vite, Express, FastAPI/Flask, Python script, static HTML. Import from GitHub URL. Export as ZIP.

**C. Live collaborative editor (the heart)**
- Monaco-based multi-file editor with file tree (create, rename, move, delete, drag-drop, upload).
- Real-time multi-user editing with **CRDTs (Yjs)**: live cursors, selections, names, colours, follow-mode ("follow Priya"), per-user undo.
- Presence: who is online, which file each person has open.
- Inline comments and line-level threads.
- Autosave with versioned snapshots; works through brief disconnects and syncs on reconnect.
- Syntax highlighting, formatting, and basic language intelligence for TS/JS, Python, HTML/CSS, JSON, Markdown. Extend with LSP over WebSocket where cheap.

**D. Shared terminal & runtime**
- Collaborative terminal (xterm.js) with modes: **owner-only, view-only for others, shared-control**. Multiple named terminals per workspace.
- Run commands in an isolated sandbox (see §5.3). Install deps, run dev servers, run tests.
- **Live preview:** any port started in the workspace gets an authenticated preview URL on an isolated origin. Teammates see it update live (HMR passes through). Toggle visibility: private to me / team / event judges / public link.

**E. Bring-your-own-device ("Local Bridge") — the differentiator**
A small CLI/daemon, `hackconnect` (Node/TypeScript, distributed via npm and single-file binaries), that the user runs on their own laptop for a project that lives locally:
- `hackconnect login` (device-code flow in browser).
- `hackconnect share [path]` links a local folder to a workspace. **Two-way file sync** between the local folder and the workspace's Yjs document tree. Respect `.gitignore` and a `.hackconnectignore`. Never upload `.env*`, keys, `node_modules`, or anything matched by a secrets scanner unless explicitly allowed.
- `hackconnect expose <port>` opens an **outbound-only secure tunnel** so teammates and judges can open the user's locally running app through the platform's preview URL (same auth and visibility rules as D). Use Cloudflare Tunnel (`cloudflared`) or an equivalent outbound tunnel; abstract it behind an interface so it can be swapped. Tunnel URLs must never be public by default.
- `hackconnect terminal` optionally mirrors a local terminal read-only (or with explicit per-session consent, interactive) into the workspace.
- Local agents (Claude Code, Cursor, Copilot, Aider, etc.) keep running on the user's own machine and editing their local files. The bridge picks up those file changes and shows them to teammates live, **attributed as "agent edit"** when the change was not made by the human (detect via process/IDE heuristics where possible, otherwise let the user tag a session as agent-driven).
- **Privacy rules (non-negotiable):** nothing leaves the machine unless the user shared it. The bridge shows a clear indicator and a one-click "stop sharing". Prompts and agent conversations are **never** captured by default. Sharing agent activity is opt-in and limited to file-change events plus an optional short summary the user writes.
- A user can alternatively just use the **screen-share** option (see F) with zero install.

**F. Voice, video, screen share, chat**
- Per-workspace and per-event rooms: voice, video, **screen share** (so someone running a local site can just show it, Discord-style), push-to-talk, mute/deafen, device selection, noise suppression.
- Use **LiveKit** (SFU). Support LiveKit Cloud and self-hosted via env config. Server issues short-lived room tokens scoped by role.
- Text chat per workspace, per team, per event, and DMs. Persisted in Postgres, delivered in real time, with markdown, code blocks, file/image upload, reactions, mentions, unread counts, search.
- Optional: raise-hand and spotlight for event rooms; recording of screen-share for judging if the organizer enables it.

**G. AI agents inside the platform**
- **Built-in agent panel** in every workspace. Provider-pluggable (Anthropic, OpenAI, Google, local/OpenAI-compatible endpoint). Users add their **own API keys** (encrypted at rest, never logged, never shown after save). Optional org-level keys for events.
- Agents act on the shared workspace through a tool layer: read file, write/patch file, list tree, run command in sandbox, read terminal output. **All agent edits go through the Yjs document** so they are live, attributable ("Claude, triggered by Rahul"), undoable, and visible to everyone.
- **Approval gate:** configurable per workspace (auto-apply, ask before write, ask before run). Show a diff before applying.
- Expose the workspace as an **MCP server** so external agents (Claude Code, Cursor, etc.) can connect to a shared workspace with a scoped token. Optionally speak ACP/agent-protocol if a mature adapter exists.
- Agent activity feed: what each agent changed, when, and on whose behalf.
- Event organizers can enable/disable/limit agents per event (e.g. "agents allowed", "agents allowed but must be declared", "no agents").

**G2. Git & GitHub**
- GitHub App (not just OAuth): link a repo to a workspace, import, commit, push, create branches and PRs from the UI, show diffs and history. Webhook for pushes. Handle conflicts visibly.
- Optionally expose a git remote for the workspace so `git clone` works against the live room.
- Workspace history is **dual**: fine-grained Yjs snapshots (for replay) and real git commits (for the repo).

**H. Hackathon hosting (organizer side)**
- Organizer creates an **Event**: title, description, banner, rules, tracks/themes, prizes, timeline (registration → hacking → submission → judging → results), team size limits, allowed tools/agent policy, eligibility, FAQs, sponsors, announcements.
- Registration with custom questions, approval flow, waitlist, check-in.
- Team formation inside the event; auto-create a workspace per team with the event template and starter repo.
- **Live Event Dashboard** for organizers: every team's status, last activity, lines changed over time, files, commit count, who is online, preview health, call presence. Filters, sorting, alerts for inactive or stuck teams. Org-wide broadcast announcements. Mentor request queue.
- **Event-wide rooms:** main stage voice/video channel, team breakout rooms, mentor office hours.
- Timer, freeze at deadline: workspaces become read-only at submission close (with organizer override), final snapshot + git tag created automatically.

**I. Submission & judging (the new criterion)**
- Submission form: title, summary, track, demo video link, repo, deployed URL, tech used, team credits. Auto-attach: final snapshot, file tree, language stats, activity timeline, declared agent usage.
- **Judge view** per submission:
  1. Final code browser (file tree, syntax-highlighted, search).
  2. **Build Replay:** a scrubbable timeline that replays how the project was built (file creation, edits, who/what made them, paste events marked, agent edits marked). Playback speed 1x–16x, per-contributor tracks, jump to "first working version". Built from Yjs update history + periodic snapshots.
  3. **Run it:** one-click "Run in sandbox" from the final snapshot (read-only, resource-capped, time-boxed) and/or open the team's preview URL, plus their demo video.
  4. **Process signals** (informational, never auto-penalising): contribution balance across members, commit/edit cadence, proportion of agent-authored vs human-authored changes, large-paste events, dependency list, time-to-first-run. Judges decide how to weigh them.
  5. Scoring: organizer-defined rubric with weighted criteria (including optional "Build Process" and "Collaboration" criteria), per-criterion score + comments, conflict-of-interest recusal, blind mode, multiple rounds, normalisation across judges, live leaderboard (hideable), tie-break rules, export CSV/JSON.
  6. Judge-to-team live Q&A in a video room with the project's preview shared.
- Results page, certificates (PDF), public gallery of past projects.

**J. Platform essentials**
- Notifications (in-app, email; web push optional), activity log, audit log for organizers/admins.
- Admin console: users, events, abuse reports, feature flags, usage and quotas.
- Billing hooks: plans/quotas data model and enforcement points (compute minutes, storage, participants). Payment provider integration (Stripe) can be stubbed behind an interface, but quota enforcement must work.
- i18n-ready, accessible (WCAG 2.1 AA targets: keyboard nav, focus states, contrast, ARIA for live regions), responsive down to tablet; mobile view-only for events/chat is acceptable.

### 2.2 Explicit non-goals for v1
Native mobile apps; Windows-only features; a full VS Code extension marketplace; running GPU workloads.

---

## 3. REFERENCE PROJECTS (research these first, then build)

Read their READMEs and architecture. **Learn patterns; do not copy code unless the licence allows it, and keep attribution in `THIRD_PARTY_NOTICES.md`.** Verify each repo still exists, is maintained, and check its licence before relying on it. If something is stale, pick the best maintained alternative and note it.

| Need | Look at | Why |
|---|---|---|
| Real-time sync | **Yjs**, `y-monaco`, **Hocuspocus** (Yjs WebSocket backend, MIT; persistence hooks, auth hooks, Redis scale-out) | Core collab engine |
| Humans + AI agents in one live room | `opencolin/ice` (ICE: collaborative IDE with agents editing through the CRDT, approval gate, shared terminal, built-in git server) | Closest conceptual match; study the agent↔Yjs adapter and CRDT↔git projection |
| Cloud IDE structure | `Algodons/algo` (Yjs + xterm.js + presence + terminal sharing), `chapeaux/fascinator` (Yjs sync over per-user code-server instances) | Terminal sharing and multi-cursor ideas |
| Full VS Code experience in browser (optional workspace mode) | **OpenVSCode Server** (Gitpod fork, tracks upstream VS Code) and **code-server** (adds password auth and port proxying) | Offer "Full VS Code" as an advanced workspace mode behind the same auth proxy |
| Hackathon management | `ScottyLabs/terrier` (registration, teams, live expo judging, Docker/Nix), `airi-utcn/hackcontrol` (Next.js, tRPC, roles, judging), `VandyHacks/witness` (judge↔team matching, schedules, CSV export) | Event, judging and scheduling data models |
| Terminal sharing | `upterm`, `tmate`, `sshx` | Session model, permissions |
| Voice/video/screen share | **LiveKit** (server, `@livekit/components-react`, egress for recording) | SFU, tokens, screen share |
| Local app sharing | **Cloudflare Tunnel** (`cloudflared`, outbound-only), plus alternatives | Local Bridge `expose` |
| Replay & integrity signals | CoderPad/Coderbyte-style playback (per-participant tracks, speed control, **paste markers**, tab-leave events) | Judge Build Replay |
| Sandboxing trade-offs | Firecracker microVMs vs gVisor/Docker containers | See §5.3 |

Also research and decide on, with notes in `docs/DECISIONS.md`: StackBlitz **WebContainers** (in-browser Node; check commercial licensing before use — treat as optional, not core), Sandpack, CodeSandbox SDK, E2B, Daytona, Coder. You may adopt a managed sandbox provider *behind the `SandboxProvider` interface* if it materially lowers risk, but self-hostable Docker/gVisor must remain the default.

---

## 4. RECOMMENDED STACK (change only with a written reason in DECISIONS.md)

- **Monorepo:** pnpm workspaces + Turborepo. TypeScript everywhere (strict).
- **Web:** keep the existing frontend framework and design system. If it is Next.js (App Router), keep it. If it is Vite/React, keep it. Do not migrate. Add TanStack Query, Zod, a typed API client.
- **API:** Node.js 22 + **Fastify** (or NestJS if the codebase already leans that way) + Zod validation + OpenAPI generated from schemas. REST for CRUD, WebSocket/SSE for events.
- **DB:** **PostgreSQL 16** + **Drizzle ORM** (or Prisma) with migrations. **Redis** for sessions, rate limits, pub/sub, BullMQ queues.
- **Collab server:** **Hocuspocus** (Yjs) as its own service, authenticating with the same JWT/session, persisting to Postgres (+ S3-compatible storage for large snapshots), Redis extension for horizontal scale.
- **Realtime media:** LiveKit (Cloud or self-hosted) + egress for optional recordings.
- **Runner service:** separate service (Node/Go) that manages sandboxes, PTYs, port proxying, file system mounts. Talks to the API over an authenticated internal channel.
- **Storage:** S3-compatible (Cloudflare R2 / S3 / MinIO in dev) for snapshots, uploads, artifacts, recordings.
- **Auth:** Better Auth or Auth.js, or Lucia-style custom with OAuth (GitHub, Google). Secure cookies, CSRF protection, session rotation, device list.
- **Local Bridge:** TypeScript CLI (`packages/bridge`), chokidar for watching, Yjs client for sync, `cloudflared` wrapper for tunnels, packaged with `pkg`/`bun build --compile` or npm.
- **Observability:** Pino logs with request IDs, OpenTelemetry traces, Sentry hooks, Prometheus metrics endpoint, health/readiness endpoints.
- **Testing:** Vitest (unit), Playwright (e2e incl. two browser contexts editing the same file), k6 or autocannon (load), Testcontainers for integration.
- **CI/CD:** GitHub Actions: lint, typecheck, test, build, container images, preview deploys, migrations on release.
- **Infra as code:** Dockerfiles per service, `docker-compose.yml` (dev) and `docker-compose.prod.yml`, plus a Kubernetes/Helm or Fly.io/Railway deployment guide. Pick one primary prod path and document it fully.

### Suggested repo layout
```
hackconnect/
  apps/
    web/            # existing frontend (wired up)
    api/            # REST + auth + events + judging
    collab/         # Hocuspocus Yjs server
    runner/         # sandbox + terminal + port proxy
    docs/           # optional docs site
  packages/
    bridge/         # `hackconnect` CLI / Local Bridge
    shared/         # zod schemas, types, constants
    db/             # drizzle schema, migrations, seed
    sdk/            # typed API client
    agent-core/     # provider adapters, tool layer, MCP server
    config/         # eslint, tsconfig, prettier
  infra/            # docker, compose, helm/fly, nginx/caddy, scripts
  docs/             # ARCHITECTURE, DECISIONS, SECURITY, RUNBOOK, API, DEPLOY
```

---

## 5. ARCHITECTURE REQUIREMENTS

### 5.1 Data model (minimum; extend as needed, with migrations and indexes)
`users, accounts(oauth), sessions, devices, profiles, teams, team_members, invites, workspaces, workspace_members, workspace_files_meta, workspace_snapshots, yjs_updates (compacted), terminals, previews, tunnels, chat_channels, chat_messages, attachments, agents, agent_runs, agent_edits, api_keys(encrypted), events, event_roles, event_registrations, event_teams, tracks, rubrics, rubric_criteria, submissions, submission_artifacts, scores, judge_assignments, announcements, mentor_requests, notifications, audit_logs, reports, plans, quotas, usage_records, feature_flags.`

Every table: `id` (uuid v7), `created_at`, `updated_at`, soft-delete where appropriate, and foreign keys with sensible `ON DELETE`. Row-level authorisation is enforced in a single policy layer (not scattered `if`s).

### 5.2 Collaboration & replay design
- One Yjs `Y.Doc` per workspace: `Y.Map<path, Y.Text>` for files + `Y.Map` for tree metadata. Awareness for cursors/presence.
- Persist incremental updates; **compact** periodically into snapshots. Keep an **event log** (`file_created`, `file_renamed`, `edit_batch`, `paste`, `agent_edit`, `run`, `commit`) with actor (human/agent/bridge), timestamp, and size. This log drives Build Replay and the live dashboard.
- Replay builds state at time *t* from nearest snapshot + subsequent updates. Must scrub a 48-hour hackathon smoothly (target: seek < 500 ms).
- Binary files and large assets live in object storage, referenced from the doc.
- Bridge sync must handle: rename/move, deletes, simultaneous local + remote edits (merge via Yjs, never silently overwrite), large files (size limit + warning), file-watcher storms (debounce, batch), and loop prevention (do not echo own writes).

### 5.3 Sandbox & security model for running untrusted code
Hackathon code is untrusted. Treat it as hostile.
- Default runtime: containers hardened with **gVisor (runsc)** or equivalent; strongest option: **Firecracker** microVMs behind the same `SandboxProvider` interface. Choose, document the trade-off (isolation vs cold-start), and make it swappable.
- Per-sandbox limits: CPU, memory, disk, PIDs, wall-clock, idle timeout. Non-root, read-only root FS where possible, dropped capabilities, seccomp profile, no Docker socket, no host mounts except the workspace volume.
- **Network:** default-deny egress with an allowlist (package registries, GitHub, selected AI provider endpoints when agents run). Block cloud metadata endpoints (169.254.169.254) and internal ranges. Per-workspace egress toggle for organizers.
- **Preview origin isolation:** previews are served from a separate wildcard domain (`*.preview.<domain>`), never the main app origin, to prevent session theft. Auth via signed short-lived token + cookie scoped to the preview domain. Set `Content-Security-Policy`, `X-Frame-Options` appropriately, and strip platform cookies.
- Judge "Run in sandbox": ephemeral, read-only snapshot, no secrets, aggressive limits, auto-destroy.
- Secrets: environment variables per workspace (encrypted, write-only in UI). Secrets scanner on Bridge uploads, commits, and snapshots (e.g. gitleaks-style rules); block or warn.
- Crypto-mining / abuse heuristics, outbound rate limits, and an admin kill switch.

### 5.4 Security baseline (applies everywhere)
- OWASP ASVS L2 as the target. Input validation with Zod at every boundary. Output encoding. Parameterised queries only.
- AuthN: secure session cookies (HttpOnly, Secure, SameSite), CSRF protection, brute-force throttling, optional TOTP 2FA for organizers/admins.
- AuthZ: centralised policy functions with tests for every role × resource × action.
- Rate limiting per IP/user/route (Redis). WebSocket auth on connect and on every room join; revoke on role change.
- Encrypt API keys/secrets with envelope encryption (KMS or a `MASTER_KEY` env with rotation support). Never log secrets or prompts.
- Dependency scanning (npm audit / Renovate / Dependabot), container scanning (Trivy), SAST in CI.
- Privacy: data export and delete-account flows; clear consent screens for Bridge sharing, screen share, recording, and process signals; retention settings for event data.
- Write `docs/SECURITY.md` with the threat model (malicious participant, malicious judge, tunnel abuse, XSS via previews, SSRF from agents, token theft) and mitigations.

### 5.5 Scale & performance targets
- 1,000 concurrent users / 200 simultaneously active workspaces on a modest cluster; design so the collab, runner, and API tiers scale horizontally (sticky routing per workspace room or Redis-backed Hocuspocus).
- Editor keystroke → remote render p95 < 150 ms in-region. API p95 < 300 ms. Workspace cold start < 30 s, warm < 5 s (prebuilt images/templates, idle pools).
- Graceful degradation: if the runner is down, editing and chat still work; if LiveKit is down, chat still works; show clear status banners.
- Backups: automated Postgres backups + PITR, object-storage versioning, restore tested and documented.

---

## 6. UX REQUIREMENTS (must feel like a polished product)

- Fast first load, skeleton states, optimistic UI, no dead ends. Every empty state explains what to do next.
- **Workspace screen layout:** file tree | editor tabs | right rail (chat, agents, participants) | bottom (terminal, preview, problems) | floating call bar with mute, camera, screen-share, leave. Resizable, remembers layout.
- One-click **"Invite teammate"** link with role selection. One-click **"Share my local app"** flow explained in plain language.
- Clear indicators wherever data is shared or recorded (red/green share dot, "recording" badge, "agent is editing" badge).
- Toasts and inline errors that say what to do. Connection-state indicator (connected / reconnecting / offline-editing).
- Keyboard shortcuts with a palette (Cmd/Ctrl+K): open file, run, toggle terminal, start/stop call, follow user.
- Dark and light themes using the existing design tokens.
- Onboarding checklist: create profile → create/join team → open workspace → invite someone → start a call.

---

## 7. EXECUTION PLAN (follow in order; ship working increments)

Create and maintain `docs/PROGRESS.md` with a checklist; tick items only when verified. After each phase: run typecheck, lint, tests, and a manual smoke test, then commit.

**Phase 0 — Recon & foundations**
- Inspect the existing frontend: framework, routing, components, design tokens, mock data, forms. List every screen and every place that needs real data. Write `docs/FRONTEND_AUDIT.md`.
- Do the research in §3. Write `docs/ARCHITECTURE.md` and `docs/DECISIONS.md` (ADR style, short).
- Set up monorepo, tooling, CI, Docker Compose (Postgres, Redis, MinIO, LiveKit dev server, Mailpit), `.env.example` with every variable documented, `make dev` / `pnpm dev` one-command start.

**Phase 1 — Identity, teams, workspaces CRUD**
Auth (OAuth + email), profiles, teams, invites, workspaces, templates, RBAC policy layer, audit log. Replace frontend mocks with the real API for these screens.

**Phase 2 — Live editor**
Hocuspocus service, Monaco + Yjs binding, file tree ops, presence, cursors, follow mode, snapshots, autosave, offline resilience. e2e test: two browsers type into the same file; assert convergence.

**Phase 3 — Chat, voice, video, screen share**
LiveKit token service, call UI, screen share, device selection, text chat with persistence, unread counts, uploads.

**Phase 4 — Runner, terminal, preview**
Sandbox provider (hardened Docker/gVisor), PTY over WebSocket, shared terminal modes, port detection, preview proxy on isolated origin with auth and visibility settings, resource limits and idle shutdown.

**Phase 5 — Local Bridge**
CLI: login, share, two-way sync, ignore rules, secrets scanner, `expose` with outbound tunnel, status UI, stop-sharing, agent-edit attribution. Test on macOS, Linux, Windows (at least path/CRLF handling). Publish scripts and install docs.

**Phase 6 — Agents & MCP**
Provider adapters, encrypted user keys, tool layer writing through Yjs, approval gate and diff view, activity feed, MCP server with scoped tokens, per-event agent policy.

**Phase 7 — GitHub integration**
GitHub App, import/link repo, commit/push/branch/PR, webhooks, history view.

**Phase 8 — Events & organizer tools**
Event CRUD, registration, team formation, auto-provisioned workspaces, live dashboard, announcements, mentor queue, event rooms, deadline freeze + final snapshot.

**Phase 9 — Submission, replay, judging**
Submission flow, artifact packaging, Build Replay, judge code browser, sandbox run, process signals, rubric scoring, assignments, blind mode, leaderboard, exports, results, certificates.

**Phase 10 — Hardening & launch**
Load tests, security review against §5.4, accessibility pass, error/empty-state sweep, performance budget, backups/restore drill, admin console, quotas, docs, seed data, demo event.

---

## 8. QUALITY BAR AND VERIFICATION (you must actually do these)

- No placeholder logic. No fake data in production paths. No `TODO` left in shipped code without a tracked issue entry in `docs/KNOWN_ISSUES.md`.
- Every API route: schema-validated, authorised, rate-limited, tested (happy path + auth failure + validation failure).
- Run the full stack and **drive it with Playwright**: sign up two users, create a team, open a workspace in two contexts, edit the same file, confirm sync, start a call (LiveKit dev), run a dev server in the sandbox, open its preview as the second user, submit to an event as a team, replay it as a judge, score it. Record the run as the acceptance test (`e2e/acceptance.spec.ts`) and keep it green.
- Include a **seed script** that creates a demo event with 3 teams, activity history (so Build Replay has something to show), 2 judges, and a rubric.
- Provide Postman/Bruno collection or OpenAPI UI for the API.
- Coverage targets: policy layer 100%, core services ≥ 80%.
- Fix every failing test and type error before moving on. If something cannot be completed, say so explicitly in `docs/KNOWN_ISSUES.md` and keep the rest working.

---

## 9. DEPLOYMENT DELIVERABLES ("ready to deploy")

1. Dockerfiles for `web`, `api`, `collab`, `runner`, and a published (or publishable) `bridge` package.
2. `docker-compose.yml` (dev) and `docker-compose.prod.yml` (single-VPS production with Caddy/Traefik, automatic HTTPS, wildcard preview domain).
3. One fully documented managed-cloud path (choose and justify, e.g. web on Vercel or equivalent; API/collab/runner on Fly.io/Railway/a VPS or Kubernetes; managed Postgres and Redis; R2/S3; LiveKit Cloud). Include DNS records (including wildcard for previews), TLS, secrets, scaling settings.
4. GitHub Actions: CI on PR, build+push images on tag, DB migration step, post-deploy smoke test.
5. `docs/DEPLOY.md` (step-by-step, copy-pasteable), `docs/RUNBOOK.md` (incidents: runner down, Redis down, LiveKit down, DB failover, abuse), `docs/ENVIRONMENT.md` (every env var, where to get it).
6. `.env.example` files for each app, with safe defaults for local dev.
7. Final `README.md`: what it is, screenshot placeholders, quick start (3 commands), architecture diagram (Mermaid), feature list, contributing, licence.

**External accounts the owner will need to supply** (list them clearly in `docs/ENVIRONMENT.md` and make the app start in a degraded-but-working local mode without them): GitHub OAuth app + GitHub App, Google OAuth client, LiveKit URL/key/secret, SMTP or Resend/Postmark key, S3/R2 credentials, an AI provider key for the demo agent, domain + wildcard DNS, optional Sentry DSN and Stripe keys.

---

## 10. WORKING RULES

- Be autonomous. Choose, build, test, continue. Log decisions, do not ask permission for routine choices.
- Prefer boring, proven technology and well-maintained open-source libraries. Check licences (MIT/Apache-2.0 preferred; avoid AGPL in the shipped product unless isolated and documented).
- Commit in small, meaningful commits using Conventional Commits. Keep `main` always runnable.
- Never commit secrets. Never disable TLS verification or security checks to "make it work".
- If a dependency or approach turns out not to work, switch quickly, note why in DECISIONS.md, and move on.
- When you finish each phase, print a short status: what works, what was verified, what is next.
- At the end, produce `docs/HANDOVER.md`: how to run, how to deploy, how to extend, what is incomplete, and the top 10 risks.

**Begin with Phase 0 now. Do not ask me anything first.**
