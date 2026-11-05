# Runbook

Health: `GET /health` (process up), `GET /ready` (state file writable, runner/kill-switch state), `GET /metrics` (Prometheus text). Logs: `docker compose -f docker-compose.prod.yml logs -f hackconnect` (set `HACKCONNECT_LOG=json`; correlate with the `x-request-id` response header).

| Incident | Symptoms | Action |
|---|---|---|
| **App down / crash loop** | Caddy 502, `/health` fails | `docker compose logs hackconnect`. If `state.json` is damaged the app restores itself from the newest good file in `.hackconnect/backups` (the damaged file is kept as `state.json.corrupt-*`) and logs it; if no valid backup exists it refuses to start rather than overwrite anything. State writes are atomic, so damage is rare |
| **Disk full** | `/ready` 503, saves fail | Free space, prune `.hackconnect/backups`, restart |
| **Restore from backup** | Data lost or wrong | `docker compose stop hackconnect`; copy a `state-*.json` over the volume's `state.json`; `docker compose start hackconnect`; run `scripts/smoke.mjs`. Edits made since the backup are lost; ask users to re-share from the Local Bridge, which will merge local files back |
| **Runner down / Docker missing** | `POST /run` returns 503 | Editing, chat, events and judging are unaffected by design. Check `docker ps`, restart the Docker daemon, or unset `HACKCONNECT_RUNNER` |
| **Realtime sync stalls** | Editor shows "Reconnecting" | Clients keep local edits and re-merge on reconnect. Check proxy WebSocket timeouts (Caddy default is fine), then restart the app: documents reload from persisted state (up to ~0.5 s of the very latest edits may need to re-sync from clients) |
| **Voice/video broken** | Call button fails | Calls use browser P2P WebRTC with a public STUN server; strict NATs need a TURN server (free: `coturn`). LiveKit is optional and not wired into the UI yet. Chat is unaffected |
| **Redis down** | n/a | Redis is not used in this version |
| **Database failover** | n/a | PostgreSQL is not used in this version (single-file state). See KNOWN_ISSUES #2 |
| **Abuse / malicious user** | Reports, odd load | Admin: `POST /api/admin/users/:id {"suspended":true}` (sessions revoked at once). Platform-wide: `POST /api/admin/kill-switch {"enabled":true}` disables agents, runs and tunnels. Review `GET /api/admin/audit` and `/api/admin/reports` |
| **Leaked API key / token** | Key in a commit or log | Revoke at the provider, rotate in `.env`, restart. For Bridge/MCP tokens: owners revoke in the workspace (`DELETE /api/projects/:id/tokens/:tokenId`) |
| **Deadline emergency** | Teams need more time | Organizer: "Unfreeze workspaces" (or `POST /api/events/:id/unfreeze`), announce the new deadline, then `POST /api/events/:id/freeze` when time is up. That takes a fresh final snapshot. Event status itself only moves forward |
| **Suspected cheating** | Judge doubts a submission | Process signals are informational; open Build Replay, check paste markers and agent share, compare against declared agent usage. Decide manually |

## Routine
- Daily during an event: check `/metrics` and the organizer dashboard "inactive teams" alerts.
- Before an event: run the restore drill, `npm run test:all` on the exact commit, `node scripts/loadtest.mjs 40 5 40`.
- After an event: export CSV/JSON (organizer page), take a final backup, delete personal data on request via the account-delete flow.
