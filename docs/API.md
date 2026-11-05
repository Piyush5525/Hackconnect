# HTTP API

JSON over HTTPS. Browser calls use the session cookie and must send `X-Requested-With: hackconnect` on POST/PUT/PATCH/DELETE. The Local Bridge uses `Authorization: Bearer hc_...` (scoped). `/mcp` accepts only workspace MCP tokens. Errors are `{ "error": "message" }` with 400 validation, 401 sign-in, 402 quota, 403 permission, 404 not found/hidden, 409 conflict, 429 rate limit.

Roles: workspace `owner > editor > viewer`; team `owner > member`; event `organizer`, `judge`, `mentor`, `participant`; platform `admin`.

## Auth and account
| Route | Notes |
|---|---|
| `POST /api/auth/signup` `{name,email,password>=10}` | First account is admin |
| `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` | Login is rate limited |
| `POST /api/auth/verify {token}`, `POST /api/auth/resend-verification` | Email confirmation |
| `POST /api/auth/forgot {email}`, `POST /api/auth/reset {token,password}` | Password reset (same answer for unknown emails; reset signs out all devices) |
| `GET /api/auth/providers` | Which of Google/GitHub are configured |
| `GET /api/auth/oauth/:provider/start[?link=1]`, `GET .../callback` | Browser redirects; `link=1` connects the provider to the signed-in account |
| `GET /api/me/identities`, `DELETE /api/auth/identities/:provider` | List / disconnect linked accounts |
| `POST /api/device/start`, `POST /api/device/token` | Local Bridge device-code login (public) |
| `POST /api/device/approve` `{userCode}` | Session only |
| `GET /api/me/usage`, `GET /api/me/export`, `DELETE /api/me {password}` | Quotas, data export, account deletion |
| `POST /api/reports` `{targetType,targetId,reason}` | Abuse report |
| `GET /api/notifications`, `POST /api/notifications` | List / mark all read |

## People
`PATCH /api/me {username?, name?, bio?}` · `GET /api/auth/username-available?u=` (public) · `GET /api/users/search?q=` · `GET /api/users/:username` · `POST /api/connections {username}` · `GET /api/me/connections` · `POST /api/connections/:id/accept|decline` · `DELETE /api/connections/:id` · `POST /api/projects/:id/invite-user {username, role}` · `POST /api/teams/:id/invite-user` · `GET /api/me/invitations` · `POST /api/invitations/:id/accept|decline` · `DELETE /api/invitations/:id`.

## Projects (import, overview, files)
`GET /api/projects/:id/overview` (README, languages, totals, contributors, members, activity) · `GET .../tree` · `GET .../file?path=` · `POST .../import {files:[{path,content}], overwrite}` (max 300 files per call) · `POST .../import-github {owner, repo, branch?, overwrite?}` · `POST .../files/mkdir {path}` · `POST .../files/rename {from,to}` · `DELETE .../files?path=&folder=1` · `GET .../export.zip` · `PATCH /api/projects/:id {name, description, agentApproval}` · `DELETE /api/projects/:id {confirmName}`.

## AI assistant settings
`GET|PUT|DELETE /api/me/ai` (provider, model, baseUrl, apiKey; the key is write-only) · `POST /api/projects/:id/agent {prompt, history, focus}`.

## Downloads (public)
`GET /download/hackconnect-vscode.vsix` · `GET /download/hackconnect-bridge.zip`.

## Teams, invites, workspaces
`POST /api/teams`, `GET /api/teams/:id`, `POST /api/teams/:id/invites` · `POST /api/invites/:token/accept` · `GET /api/bootstrap` · `POST /api/projects` `{name,description,teamId?}` · `GET /api/projects/:id` · `PATCH /api/projects/:id {agentApproval:"ask"|"auto"}` (owner) · `GET/PATCH/DELETE /api/projects/:id/members[/:userId]` · `POST /api/projects/:id/invites {role}` · `PUT /api/projects/:id/files {path,content}` (refuses `.env`-like names, warns on secrets) · `POST /api/projects/:id/messages` · `GET /api/projects/:id/replay` · `POST /api/projects/:id/github/sync` (owner).

Agents and automation: `POST /api/projects/:id/agent {prompt}` (built-in agent; returns `changes` applied and `proposals` awaiting approval) · `GET /api/projects/:id/proposals` · `POST /api/projects/:id/proposals/:pid/approve|reject` · `POST|GET|DELETE /api/projects/:id/tokens` (owner; MCP tokens) · `POST|GET|PATCH|DELETE /api/projects/:id/tunnels` · `POST /api/projects/:id/call-token` (503 + `fallback:"p2p"` without LiveKit) · `POST /api/projects/:id/run {command}` (503 unless the sandbox runner is enabled).

## MCP (`POST /mcp`, JSON-RPC 2.0)
`initialize`, `tools/list`, `tools/call` with `list_files`, `read_file`, `write_file`, `replace_in_file`. Writes become proposals unless the workspace is set to auto-apply. Example:
```bash
claude mcp add --transport http hackconnect https://your.host/mcp --header "Authorization: Bearer hc_..."
```

## Realtime
`/ws?projectId=` JSON events (chat, presence, call signalling, `proposals.changed`). `/collab?projectId=` binary Yjs sync (y-protocols); Bridge clients may send `x-hc-agent: <name>` to tag edits as agent-authored.

## Events
| Route | Who |
|---|---|
| `GET/POST /api/events`, `GET/PATCH /api/events/:id` | anyone / organizer (PATCH moves status forward: draft, registration, hacking, submission, judging, results; entering judging freezes workspaces) |
| `POST /api/events/:id/register` · `POST .../roles {email,role}` · `POST .../checkin {userId}` · `POST .../announcements {text}` | participant / organizer |
| `POST .../teams {name}` · `POST .../teams/:tid/join` · `GET .../mine` | participant (team size limited; creates the workspace) |
| `GET .../dashboard` | organizer (activity, idle time, agent share, inactive alerts) |
| `POST|GET|PATCH .../mentor-requests` | participant creates, mentor/organizer manage |
| `PUT .../submission` | team member (agent usage declaration enforced by policy) |
| `POST .../freeze`, `POST .../unfreeze` | organizer |
| `POST .../assignments {judgeId,submissionIds}` | organizer |
| `GET .../submissions[/:sid]`, `GET .../submissions/:sid/replay[/state?index=]`, `POST .../submissions/:sid/scores` | judge / organizer (blind mode honoured; scoring judge-only, COI blocked) |
| `GET .../leaderboard?mode=raw|normalized` | organizer always; judges when enabled; everyone after results |
| `GET .../export?format=csv|json` | organizer |
| `GET .../certificate/:teamId` | team members / organizer after results (PDF) |
| `GET /api/gallery` | signed-in users, results-phase events only |

## Admin (platform admin only)
`GET /api/admin/overview|users|reports|audit` · `POST /api/admin/users/:id {suspended?,plan?}` · `PUT /api/admin/flags {name,enabled}` · `POST /api/admin/kill-switch {enabled}` · `POST /api/admin/reports/:id`.

## Tunnel previews
`GET /t/<tunnelId>/<token>/<path>` read-only authenticating proxy; tokens come from `GET /api/projects/:id/tunnels` (`previewUrl`).

## Ops
`GET /health`, `GET /ready`, `GET /metrics` (Prometheus text, optional bearer token).
