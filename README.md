<p align="center">
  <img src="docs/assets/banner.svg" alt="HackConnect: build hackathon projects together, live" width="100%">
</p>

<p align="center">
  <img alt="Node 22" src="https://img.shields.io/badge/Node-22+-3c873a?logo=nodedotjs&logoColor=white">
  <img alt="Yjs CRDT" src="https://img.shields.io/badge/Live%20editing-Yjs%20CRDT-58e0aa">
  <img alt="Monaco" src="https://img.shields.io/badge/Editor-Monaco-0078d4?logo=visualstudiocode&logoColor=white">
  <img alt="WebRTC" src="https://img.shields.io/badge/Calls-WebRTC-ff6b6b?logo=webrtc&logoColor=white">
  <img alt="Frontend on Vercel" src="https://img.shields.io/badge/Frontend-Vercel-000000?logo=vercel&logoColor=white">
  <img alt="Backend on Render" src="https://img.shields.io/badge/Backend-Render-46e3b7?logo=render&logoColor=black">
  <img alt="No database needed" src="https://img.shields.io/badge/Storage-one%20JSON%20file-b9f07c">
</p>

<p align="center"><b>Google Docs + VS Code Live Share + Discord + Devpost, for hackathons.</b><br>
Teams edit the same files live, talk in voice and video, bring their own AI with an approval gate, and organizers run the whole event: registration, team workspaces, a live dashboard, a deadline freeze and judging with a replayable build history.</p>

---

## Contents
[Screenshots](#screenshots) · [What you can do](#what-you-can-do) · [How it works](#how-it-works) · [Quick start](#quick-start) · [Deploy](#deploy-frontend-on-vercel-backend-on-render) · [Configuration](#configuration) · [Develop and test](#develop-and-test) · [Docs](#documentation) · [Project layout](#project-layout)

---

## Screenshots

<p align="center">
  <img src="docs/screenshots/workspace.png" alt="Live workspace: file explorer, Monaco editor with teammates' cursors, team chat" width="100%">
  <br><sub><b>Live workspace</b>: explorer, Monaco editor with live teammate cursors, team chat and assistant on the right.</sub>
</p>

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/overview.png" alt="Overview"><br><sub><b>Overview</b>: your projects with language bars and contributors, plus the hackathons you take part in.</sub></td>
    <td width="50%"><img src="docs/screenshots/projects.png" alt="My projects"><br><sub><b>My projects</b>: search, sort, open a project page or the live workspace.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/call-fullscreen.png" alt="Full-screen call"><br><sub><b>Voice and video calls</b>: box-sized tiles, speaker highlight, screen share, pin, invite.</sub></td>
    <td width="50%"><img src="docs/screenshots/inbox-call-invite.png" alt="Inbox with a join-call message"><br><sub><b>Call invites</b>: teammates get an inbox message and a live prompt with a one-click <i>Join call</i>.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/call-volume-menu.png" alt="Per-person volume menu"><br><sub><b>Per-person volume</b>: right-click anyone for a live speaking meter, volume, mute-for-me and pin.</sub></td>
    <td width="50%"><img src="docs/screenshots/call-invite.png" alt="Invite teammates to the call"><br><sub><b>Invite to the call</b>: pick who to ring, in one click.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/hackathons.png" alt="Hackathons"><br><sub><b>Hackathons</b>: host or join events with phases, teams and judging.</sub></td>
    <td width="50%"><img src="docs/screenshots/my-hackathons.png" alt="My hackathons tracker"><br><sub><b>My hackathons</b>: track any hackathon, with staged deadline reminders in your inbox.</sub></td>
  </tr>
</table>

<details>
<summary><b>More screens</b> (sign in, call panel, menus, phone)</summary>
<br>
<table>
  <tr>
    <td width="33%"><img src="docs/screenshots/signin.png" alt="Sign in"><br><sub>Sign in with email, Google or GitHub</sub></td>
    <td width="33%"><img src="docs/screenshots/call-dock.png" alt="Call docked in the side panel"><br><sub>A call docked beside your code</sub></td>
    <td width="33%"><img src="docs/screenshots/workspace-menu.png" alt="Workspace menu"><br><sub>Share (view or edit link) and the ⋯ menu</sub></td>
  </tr>
  <tr>
    <td width="33%"><img src="docs/screenshots/workspace-chat.png" alt="Workspace chat"><br><sub>Project chat with reactions</sub></td>
    <td width="33%"><img src="docs/screenshots/activity.png" alt="Activity"><br><sub>Activity timeline</sub></td>
    <td width="33%"><img src="docs/screenshots/mobile.png" alt="Phone layout" width="180"><br><sub>Works on a phone</sub></td>
  </tr>
</table>
</details>

> The screenshots are generated from the real app by `node scripts/readme-shots.mjs`, using a throwaway instance, so none of your own data is ever captured.

---

## What you can do

| | |
|---|---|
| **Projects like on GitHub** | Import files, a folder, a zip or a GitHub repository. See the rendered README, a language chart, contributors with avatars, and browse every file. |
| **Live workspace** | Monaco editor on a Yjs CRDT: live remote cursors, presence, follow mode, offline edits merge on reconnect, viewers are read-only. Explorer, tabs, status bar, resizable panels, command palette. |
| **Teams and access** | Unique `@usernames`, connection requests, invite by username or by a **view / edit link**, change a teammate's role or remove them any time, audit log, quotas. |
| **Voice and video** | Several voice channels per project. Voice-only joins stay quiet in a side dock; video can pop out into a floating window or go full screen. Screen share, pin, per-person volume, and **"come join the call" invites** that land in the inbox with a Join button. |
| **AI assistant (bring your own)** | Sign in with **Claude Code or Codex** through a tiny local launcher (your own subscription, no API key), or use Ollama, Groq, Gemini, OpenRouter, OpenAI or Claude with a key stored encrypted. Every change shows a diff and **waits for your approval** (or auto-applies if you choose). |
| **Inbox and reminders** | One dropdown for requests, call invites and updates. Hackathon deadlines notify you at staged intervals before they close. |
| **Overview** | Your recent projects with language bars and contributors, plus a row of cards for the hackathons you take part in (status, source and a live deadline countdown). The "Get started" checklist disappears once every step is done. |
| **Hackathons** | Phases, registration, teams with auto-provisioned workspaces, live organizer dashboard, announcements, mentor requests, deadline freeze with a final snapshot. |
| **Judging** | Submissions with an AI-usage declaration, **Build Replay** (scrub or play 1x to 16x), rubric scoring, blind mode, assignments, conflict-of-interest block, leaderboard, CSV/JSON export, PDF certificates. |
| **Local Bridge CLI** | `hackconnect login \| share \| expose \| workspaces`: two-way folder sync with consent, secret scanner, free `cloudflared` tunnels to share a running app. |
| **Ops** | `/health`, `/ready`, `/metrics`, JSON logs, automatic backups, CI, load test. |

Honest limits (single instance, JSON file storage, no PTY terminal): [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md).

---

## How it works

### Architecture (frontend on Vercel, backend on Render)
```mermaid
flowchart LR
  U([Browser]) -->|static files| V[Vercel<br/>frontend]
  V -->|"/api, /download, /t, /mcp<br/>rewritten (same address, normal cookies)"| R[Render<br/>Node backend]
  U ==>|"live sockets /ws /collab<br/>one-time ticket"| R
  R --> D[(Persistent disk<br/>state.json + backups)]
  R -.->|optional| M[SMTP email]
  R -.->|optional| O[GitHub / Google sign-in]
  L[Local assistant launcher<br/>Claude Code / Codex] -.->|"runs on your computer"| U
  B[Local Bridge CLI] -->|Bearer token| R
  X[External agents<br/>Claude Code, Cursor] -->|MCP /mcp| R
```
Vercel cannot carry WebSockets and browsers refuse cross-site cookies, so ordinary requests go through Vercel's rewrites (same address, normal login cookie) and only the live sockets connect straight to Render, signed in by a **60-second single-use ticket** (`POST /api/ws-ticket`). Prefer one address? Deploy only the backend: it serves the UI itself.

### From sign-up to shipping
```mermaid
flowchart TD
  A([Sign up]) --> B[Create or import a project]
  B --> C[Invite teammates<br/>by username or view / edit link]
  C --> D[Edit together in the live workspace]
  D --> E{Need to talk?}
  E -->|yes| F[Join a voice channel<br/>invite others to the call]
  E -->|no| G[Ask your AI assistant]
  F --> D
  G --> H[Review the diff]
  H -->|approve| D
  H -->|reject| G
  D --> I[Join a hackathon<br/>register, form a team]
  I --> J[Deadline freeze + final snapshot]
  J --> K([Judging with Build Replay])
```

### Live editing
```mermaid
sequenceDiagram
  participant A as Maya (browser)
  participant S as Backend
  participant B as Arjun (browser)
  A->>S: POST /api/ws-ticket (signed in)
  S-->>A: one-time ticket (60 s)
  A->>S: open /collab?projectId=... &ticket=...
  B->>S: open /collab (same way)
  A->>S: Yjs update (typed text)
  S-->>B: Yjs update, cursors and presence
  Note over A,B: CRDT merge: no lost keystrokes,<br/>offline edits merge on reconnect
  S->>S: debounce and persist to state.json
```

### "Come join the call" invites
```mermaid
sequenceDiagram
  participant H as Host (in a call)
  participant S as Backend
  participant T as Teammate
  H->>S: POST /projects/:id/call-invite {channel, userIds}
  S->>S: write an inbox message for each person
  S-->>T: live prompt "Maya invited you to a call" [Join] (if the project is open)
  Note over T: otherwise the inbox bell lights up within 15 s
  T->>S: click Join / Join call
  S-->>T: opens the project, joins the same voice channel
  T-->>H: appears in the call (WebRTC peer connection)
```

### AI assistant with your own account
```mermaid
flowchart LR
  P[Assistant panel] -->|"prepare"| S[Backend<br/>builds the prompt with workspace context]
  S --> P
  P -->|"127.0.0.1:47831"| L[Local launcher<br/>uses your signed-in Claude Code / Codex]
  L --> P
  P -->|"localText"| S
  S --> Q{Edit mode}
  Q -->|Ask first| R[Diff waits for your approval]
  Q -->|Auto-apply| W[Applied and shown in history]
  R -->|approve| W
```
No API key ever reaches the server for Claude/Codex sign-in: the launcher runs on your own computer and the browser talks to it directly.

### Hackathon lifecycle
```mermaid
stateDiagram-v2
  [*] --> Draft
  Draft --> Registration: publish
  Registration --> Hacking: start
  Hacking --> Submission
  Submission --> Judging: deadline or manual, workspaces freeze
  Judging --> Results: scores normalised
  Results --> [*]
```

---

## Quick start
```bash
git clone https://github.com/Piyush5525/Hackconnect.git
cd Hackconnect
npm install          # also builds the editor bundle (Yjs + Monaco)
npm start            # open http://localhost:4173 and create an account
```
The first account you create becomes the platform admin. Docker: `docker compose up --build`.

## Deploy: frontend on Vercel, backend on Render
1. **Render** (backend): *New → Blueprint*, pick this repo. It reads [`render.yaml`](render.yaml): Docker, one instance, a 1 GB disk at `/app/.hackconnect`, health check `/health`.
2. **Vercel** (frontend): put your Render address into every rewrite in [`vercel.json`](vercel.json), push, then *Add New → Project* and import the repo (preset **Other**; the build command and output folder are already set).
3. **Connect them** (Render → Environment): `HACKCONNECT_BASE_URL` = your Vercel address, `HACKCONNECT_API_URL` = your Render address. Redeploy.
4. Open the **Vercel** address and sign up first: that account is the admin.

Full walkthrough, backups and troubleshooting: [docs/DEPLOY.md](docs/DEPLOY.md). Check a deployment locally with `npm run e2e:split`.

## Configuration
Copy `.env.example` to `.env`. The important ones:

| Variable | Purpose |
|---|---|
| `HACKCONNECT_BASE_URL` | The public address people open (links in emails, sign-in callbacks, who may open live sockets). |
| `HACKCONNECT_API_URL` | The backend's own address (CLI bridge and VS Code extension downloads). |
| `HACKCONNECT_MASTER_KEY` | Encrypts stored GitHub tokens. Generate once, never change. |
| `SMTP_*` | Real confirmation and password-reset emails. |
| `GITHUB_CLIENT_ID/SECRET`, `GOOGLE_CLIENT_ID/SECRET` | "Continue with GitHub / Google". |
| `HACKCONNECT_TRUST_PROXY` | `true` behind Vercel / Render so rate limits use the visitor's address. |

Every variable: [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md). Run `npm run check:secrets` before every commit.

## Develop and test
```bash
npm test                 # unit + integration (policy matrix, API, collab convergence, events, bridge, MCP, CLI)
npm run e2e              # two real browsers edit one file and converge
npm run e2e:projects     # projects, people, inbox, member management
npm run e2e:call-invite  # call invites reach the inbox and one click joins the call
npm run e2e:call-volume  # per-person volume + screen share keeps the grid
npm run e2e:signin       # connect Claude / Codex, edit modes, past chats
npm run e2e:split        # the Vercel + Render setup: proxy + ticketed sockets
npm run build:client     # rebuild vendor/ (Yjs + Monaco) after editing src/
node scripts/readme-shots.mjs   # regenerate the screenshots above
```

## Documentation
[Architecture](docs/ARCHITECTURE.md) · [Deploy](docs/DEPLOY.md) · [Environment](docs/ENVIRONMENT.md) · [API](docs/API.md) · [Security](docs/SECURITY.md) · [Runbook](docs/RUNBOOK.md) · [Decisions](docs/DECISIONS.md) · [Known issues](docs/KNOWN_ISSUES.md)

## Project layout
```
index.html, app.js, *-ui.js     the interface (vanilla JS, no build step)
config.js, net.js               where the backend lives + how live sockets connect
src/                            editor client source (Yjs + Monaco), bundled into vendor/
lib/                            backend: app, auth, collab, events, judging, tracker, social, agent...
bridge/                         Local Bridge CLI and the assistant launcher
scripts/                        build-frontend (Vercel), build-client, backup, smoke, readme-shots...
render.yaml, vercel.json        deployment blueprints
test/, e2e/                     unit and real-browser tests
```

<p align="center"><sub>Built for hackathon teams. Free and open-source tools all the way down.</sub></p>
