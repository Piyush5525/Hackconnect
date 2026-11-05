# Frontend audit

## Current implementation

The existing frontend is a single responsive HTML document (`index.html`) with a dark visual language, CSS design tokens, and vanilla JavaScript. There is no React, Next.js, Vite, router, build step, or component library to preserve. `app.js` is now the backend adapter layered over the original visual prototype.

## Existing screens

| Screen | Current state | Data source |
| --- | --- | --- |
| Overview | Dashboard, stats, recent projects, activity, team | `/api/bootstrap` |
| My projects | Project list and room entry | `/api/projects` through bootstrap |
| Hackathons | Static discovery cards and leaderboard presentation | Static UI; event API not yet implemented |
| Live workspace | File explorer, editor, presence, chat, agent panel, call controls, GitHub sync | Project REST API + `/ws` |
| Activity | Static presentation timeline | API data is available; view still needs rendering adapter |

## Wiring completed

- Project creation persists on the server.
- File saves persist on the server and broadcast through WebSocket.
- Room chat persists and broadcasts.
- Presence and active-file state are broadcast per room.
- Agent requests go through the backend and can apply validated file-content changes.
- Browser camera, microphone, screen-share, and basic WebRTC signaling are connected.
- GitHub Contents API sync is available when a token is explicitly configured.

## Gaps tracked for later phases

- Monaco/Yjs editor is not yet present; the current editor is a safe textarea with server fan-out.
- Authentication and role-aware routing are not present.
- Hackathon registration, submissions, judging, and replay data are not yet persisted.
- Terminal execution is intentionally not exposed until an isolated runner exists.
