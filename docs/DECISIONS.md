# Architecture decisions

## ADR-001 — Keep the existing frontend

**Decision:** Keep the single-page visual frontend and wire it with `app.js` instead of migrating frameworks.

**Reason:** The workspace contains no framework project; a migration would discard the supplied design and delay usable functionality. The current DOM can later be split into components without changing the backend contract.

## ADR-002 — Free local runtime first

**Decision:** Default to Node HTTP, WebSocket, and a JSON file store. Default the agent to `demo` mode.

**Reason:** The owner requested free services and no configured key values are available in the workspace. This makes `npm start` and `docker compose up` work without an external account.

## ADR-003 — No server-side arbitrary command execution yet

**Decision:** Do not add a terminal runner until it has a sandbox boundary.

**Reason:** Executing participant or agent commands in the web server would be a critical remote-code-execution vulnerability. The production design will use a separate hardened runner with resource limits and deny-by-default network policy.

## ADR-004 — WebRTC fallback before LiveKit

**Decision:** Use browser WebRTC plus WebSocket signaling locally; leave LiveKit behind a future media adapter.

**Reason:** WebRTC is free for local/small-team testing. TURN/SFU reliability and recording require infrastructure that cannot be safely replaced by a free API key.

## ADR-005 — Provider-neutral agent contract

**Decision:** Agents return `{ message, changes[] }`, where each change is a relative path and complete file content.

**Reason:** The contract is easy to validate, audit, broadcast, and later route through Yjs. Demo, OpenAI, Anthropic, and future local OpenAI-compatible providers can share it.


## ADR: Auth without extra dependencies (Phase 1)
Sessions are opaque random tokens stored hashed (SHA-256) server-side, sent in an HttpOnly SameSite=Lax cookie. Passwords use Node's built-in scrypt. CSRF is handled by requiring a custom `X-Requested-With` header on mutations. This keeps the runtime at one dependency (`ws`) until the move to Postgres/Better Auth; the policy layer is independent of the auth mechanism so it survives that swap.

## ADR: Hide existence of private workspaces
Requests for projects a user is not a member of return 404, not 403, so ids cannot be probed.

## ADR: In-process Yjs sync instead of Hocuspocus (Phase 2)
`y-protocols` is used directly inside the API process. This reuses the existing session auth, avoids a second service while the app is single-host, and keeps the dependency count low. Moving to Hocuspocus + Redis is a contained swap behind `lib/collab.mjs` when horizontal scale is needed.

## ADR: Textarea binding first, Monaco later (superseded: Monaco is now in)
There is no frontend build step yet, and Monaco needs a bundler/worker setup. The CRDT layer and awareness protocol are editor-agnostic, so Monaco (y-monaco) can replace `bind()` in `src/collab-client.js` without protocol changes. The client bundle is built with esbuild and committed (`vendor/collab-client.js`) so Docker builds need no dev dependencies; run `npm run build:client` after editing `src/`.

## ADR: Free and open-source only
Requirement from the owner: use only free apps. Every dependency is MIT/Apache-2.0; hosting uses a VPS + Caddy (free TLS); AI uses Ollama or any OpenAI-compatible free tier (keyless demo mode otherwise); tunnels use `cloudflared`; calls use browser WebRTC with optional self-hosted LiveKit; browser tests use Playwright. No feature requires a paid account.

## ADR: Keep JSON-file state for v1 (deviation from the brief)
The brief recommends PostgreSQL + Redis + S3. Those need external services and a migration layer that cannot be verified here without them, so state stays in one atomically-written JSON file behind `db` + `save()`. The policy layer, routes and tests do not depend on the storage format, so a Postgres repository can replace it later. Consequence: single instance only (documented in DEPLOY and KNOWN_ISSUES).

## ADR: Bearer tokens are scoped by kind
`bridge` tokens act as the user but only on `/api/projects/*`, `/api/auth/me`, `/api/bootstrap`; `mcp` tokens are bound to one workspace and role and only work on `/mcp`. Cookie sessions are never accepted on `/mcp`, and bearer requests skip the CSRF header (no ambient credentials). Device-code endpoints are the only cookie-less mutating routes exempt from CSRF.

## ADR: Approval gate defaults to "ask"
Agent writes (built-in or MCP) are queued as proposals with diffs unless an owner opts a workspace into auto-apply. Event policy `none` and the admin kill switch override everything.

## ADR: Judge data derives from the frozen snapshot
Submissions are packaged from the final snapshot taken when judging starts (files, languages, dependencies, signals, replay slice), so later edits by an organizer override cannot change what judges saw.

## ADR: Local Bridge uses fs.watch, not chokidar
Node 20+ has recursive `fs.watch` on Windows, macOS and Linux, so the Bridge has no native dependency. The watch root is resolved to its canonical long path because Windows 8.3 short names crash libuv's recursive watcher.

## ADR: Monaco in one bundle with Yjs
Two bundles would each carry a Yjs copy, which breaks `instanceof` checks and logs warnings, so Monaco, y-monaco and the collab client are one esbuild bundle (`vendor/collab-client.js`); only Monaco's language workers are separate files. Models are pinned to LF (Monaco defaults to CRLF on Windows, which would drift from the shared text) and disposed 3 s late so in-flight completion requests cannot hit a disposed model. `vendor/` is generated, git-ignored and built in a Docker build stage.

## ADR: OAuth without a library
Two providers with a standard authorization-code + PKCE flow need about 150 lines (`lib/oauth.mjs`), so no auth framework was added. Provider endpoints are overridable by env vars, which lets the test suite run the whole flow against a fake provider. Pre-registered unverified password accounts are not trusted when a verified OAuth identity claims the same email (their password is removed), which closes the classic pre-account-takeover hole until email verification exists.

## ADR: Encrypted third-party tokens
GitHub tokens are encrypted with AES-256-GCM using `HACKCONNECT_MASTER_KEY` or a generated `.hackconnect/master.key` (mode 0600). The key is kept out of the state file so a leaked backup alone does not reveal tokens. Rotation is not implemented: changing the key requires users to reconnect GitHub.

## ADR: No demo data in production paths
A new installation starts empty. The original prototype's fake projects and "first user adopts them" behaviour were removed, and the Overview, Activity and sidebar are driven by real data. Hackathon demo content exists only in `scripts/seed.mjs`, which must be run on purpose.

## ADR: Project page data from history, not git
Contributors and activity come from the per-save edit history (with `uid` attribution), languages from stored file contents by bytes (GitHub-style categories). This works for projects that never touched git. A GitHub App with real commits is future work.

## ADR: "Extensions" are editor features plus downloads
Marketplace VS Code extensions need the full VS Code runtime, so they cannot run in the browser editor. The in-app Extensions panel exposes built-in editor features (themes, format on save, minimap, brackets...) and offers a generated VS Code extension (.vsix) and the Local Bridge package to bring HackConnect into the user's own editor. The .vsix is built from templates in `lib/downloads.mjs` (structure and JavaScript are tested; it has not been installed into a real VS Code here).

## ADR: Sanitised Markdown in the browser
README and assistant replies are rendered client-side with `marked` + DOMPurify inside the same bundle as Yjs/Monaco; https images are allowed (CSP `img-src https:`), everything else dangerous is stripped.
