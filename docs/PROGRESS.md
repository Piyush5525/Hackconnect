# Build progress

Ticked only when verified by a test or a manual run on this machine. `npm run test:all` runs everything below that has a test.

## Phase 0 - Recon and foundations
- [x] Frontend audit, architecture and decision records, reproducible server, Docker Compose, health endpoint.
- [x] Free-first stack (no paid service required anywhere).

## Phase 1 - Identity, teams, workspaces (partial)
- [x] Email+password accounts, hashed sessions, CSRF guard, rate limits, audit log, account export/delete.
- [x] Central policy layer with a role x action test matrix; teams; invite links; member management; quotas.
- [x] Google + GitHub OAuth (authorization code + PKCE, state bound to a cookie), account linking, encrypted GitHub tokens, takeover guard, Connections panel. Tests: `test/oauth.test.mjs`, `npm run e2e:auth`.
- [x] Email confirmation, password reset, per-account lockout, SMTP or local-outbox mail. Tests: `test/mail.test.mjs`, `npm run e2e:auth`.
- [ ] Profiles, team finder, templates, import/export, PostgreSQL.

## Phase 2 - Live editor (partial)
- [x] Yjs CRDT sync, presence, follow mode, reconnect/offline merge, persistence, viewer read-only. Tests: `test/collab.test.mjs`, `npm run e2e` (two real browsers).
- [x] Monaco editor with remote cursors/selections/names, built into `vendor/` by `npm run build:client` (runs on `npm install`).
- [ ] Rename/move/delete/upload, comments, per-user undo, compaction.

## UX round: projects, people, IDE (complete)
- [x] Logo (SVG mark + wordmark, favicon, PNG icons, manifest) applied to the site, sign-in and README.
- [x] Unique usernames, search, profiles, connection requests, invitations by username. Tests: `test/social.test.mjs`.
- [x] Project import (files, folder, zip, GitHub), language chart, contributors, rendered README, file browser, rename/delete/export ZIP, project settings and delete. Tests: `test/projects.test.mjs`.
- [x] IDE workspace: nested explorer with file operations, tabs, status bar, resizable panels, assistant panel, Ctrl+K palette, extensions panel, VS Code extension and Bridge downloads. Tests: `test/ai.test.mjs`, `npm run e2e:projects`.
- [x] Real Overview and Activity pages; all demo/mock data removed; hackathon dialogs replaced prompt() popups; deadline can be set from the UI.

## Phase 3 - Chat and media (minimal)
- [x] Persisted workspace chat, browser WebRTC calls and screen share (original), LiveKit token endpoint.
- [ ] LiveKit UI, chat features, event rooms, recording.

## Phase 4 - Runner (interface only)
- [x] `SandboxProvider` interface, hardened Docker/gVisor provider (argv tested), kill switch, rate limits.
- [ ] Verified live run, PTY terminal, preview proxy, judge sandbox run.

## Phase 5 - Local Bridge (core done)
- [x] CLI: device-code login, consent prompt, two-way sync, ignore rules, secrets scanner, CRLF and conflict handling, loop prevention, path-traversal defence, agent tagging, tunnel registration, stop-sharing indicator. Tests: `test/platform.test.mjs`, `test/cli.test.mjs`.
- [ ] Terminal mirror, binaries/npm publish, macOS/Linux verification.

## Phase 6 - Agents and MCP (core done)
- [x] Built-in agent (free `compatible` provider added), approval gate with diffs, MCP server with scoped tokens, event agent policy, admin kill switch.
- [ ] Per-user encrypted keys, ACP, org keys.

## Phase 7 - GitHub (minimal)
- [x] One-way sync with a token. [ ] GitHub App, branches/PRs, webhooks.

## Phase 8 - Events and organizer tools (core done)
- [x] Event CRUD, phases, registration, team formation with auto-provisioned workspaces, live dashboard with alerts, announcements, notifications, mentor requests, deadline freeze with final snapshot. Tests: `test/events.test.mjs`, `npm run e2e:events`.
- [ ] Custom registration, waitlist, scheduler, event rooms.

## Phase 9 - Submission, replay, judging (core done)
- [x] Submissions with agent declaration, artifacts (files, languages, deps), Build Replay with scrubber and 1x-16x playback and paste/agent markers, process signals, rubric scoring, blind mode, assignments, COI block, normalisation, tie-break, leaderboard, CSV/JSON export, certificates (PDF), gallery.
- [ ] Multi-round, judge Q&A room, sandbox run.

## Phase 10 - Hardening and launch (partial)
- [x] Load test (`scripts/loadtest.mjs`: 200 sockets / 40 workspaces, p95 about 23 ms), CSP and headers, request ids, `/ready` and `/metrics`, admin console API, quotas, seed script, backup script, CI/release workflows, Dockerfiles, prod compose, deploy/runbook/security/environment/API docs.
- [ ] Accessibility pass, restore drill on a real host, CI executed on a remote, coverage measurement.
