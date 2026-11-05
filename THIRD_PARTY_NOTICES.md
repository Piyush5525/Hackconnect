# Third-party notices

HackConnect runtime depends only on the libraries below (all free, permissive licences). Versions are pinned by `package-lock.json`; run `npm ls --omit=dev` for the exact tree.

| Package | Licence | Use |
|---|---|---|
| [yjs](https://github.com/yjs/yjs) | MIT | CRDT document model |
| [y-protocols](https://github.com/yjs/y-protocols) | MIT | Sync and awareness wire protocol |
| [lib0](https://github.com/dmonad/lib0) | MIT | Encoding helpers used by Yjs |
| [ws](https://github.com/websockets/ws) | MIT | WebSocket server/client |
| [monaco-editor](https://github.com/microsoft/monaco-editor) | MIT | Code editor (bundled into `vendor/`) |
| [y-monaco](https://github.com/yjs/y-monaco) | MIT | Yjs <-> Monaco binding, remote cursors |

Dev/test only: [esbuild](https://github.com/evanw/esbuild) (MIT) builds `vendor/collab-client.js`; [Playwright](https://github.com/microsoft/playwright) (Apache-2.0) runs the browser acceptance tests.

## Patterns studied, no code copied
Architecture ideas were taken from the projects named in the build brief (Hocuspocus, y-monaco, ICE, code-server, terrier, hackcontrol, witness, upterm/tmate/sshx, LiveKit, Cloudflare Tunnel, CoderPad-style replay). None of their source is included. Before adopting any of them as a dependency, re-check that the repository is maintained and its licence is compatible (avoid AGPL in the shipped product).

## Optional external tools (not bundled)
`cloudflared` (Apache-2.0) for `hackconnect expose`; Docker/gVisor for the sandbox runner; Caddy (Apache-2.0) in `docker-compose.prod.yml`; LiveKit server (Apache-2.0) behind the `calls` profile; Ollama (MIT) as a free local AI endpoint.
