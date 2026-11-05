// Collab load test: W workspaces x C clients. One writer per workspace types; we measure time until every other client sees each edit.
//   node scripts/loadtest.mjs [workspaces=20] [clientsPerWorkspace=5] [keystrokes=40]
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { createApp } from '../lib/app.mjs';

const [W, C, K] = [Number(process.argv[2] || 20), Number(process.argv[3] || 5), Number(process.argv[4] || 40)];
const root = fileURLToPath(new URL('..', import.meta.url)); const dir = mkdtempSync(join(tmpdir(), 'hc-load-'));
const app = createApp({ root, stateFile: join(dir, 's.json'), authLimit: 1e6 }); await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;
const api = async (cookie, method, path, body) => { const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { res, json: await res.json().catch(() => ({})) }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const percentile = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

const connect = (cookie, id) => new Promise((resolve) => {
  const doc = new Y.Doc(); const ws = new WebSocket(`${base.replace('http', 'ws')}/collab?projectId=${id}`, { headers: { cookie } }); const c = { doc, ws, files: doc.getMap('files') };
  doc.on('update', (u, o) => { if (o === ws) return; const e = encoding.createEncoder(); encoding.writeVarUint(e, 0); syncProtocol.writeUpdate(e, u); if (ws.readyState === 1) ws.send(encoding.toUint8Array(e)); });
  ws.on('open', () => { const e = encoding.createEncoder(); encoding.writeVarUint(e, 0); syncProtocol.writeSyncStep1(e, doc); ws.send(encoding.toUint8Array(e)); });
  ws.on('message', (d) => { const dec = decoding.createDecoder(new Uint8Array(d)); if (decoding.readVarUint(dec) !== 0) return; const reply = encoding.createEncoder(); encoding.writeVarUint(reply, 0); const t = syncProtocol.readSyncMessage(dec, reply, doc, ws); if (encoding.length(reply) > 1) ws.send(encoding.toUint8Array(reply)); if (t === syncProtocol.messageYjsSyncStep2 && !c.ready) { c.ready = true; resolve(c); } });
});

console.log(`Setting up ${W} workspaces x ${C} clients (${W * C} sockets)…`);
const rooms = [];
for (let w = 0; w < W; w++) {
  const members = [];
  for (let c = 0; c < C; c++) { const r = await api('', 'POST', '/api/auth/signup', { name: `U${w}-${c}`, email: `u${w}-${c}@load.io`, password: 'load-test-pw-1' }); members.push({ cookie: r.res.headers.get('set-cookie').split(';')[0] }); }
  const id = (await api(members[0].cookie, 'POST', '/api/projects', { name: `load-${w}` })).json.id; const inv = (await api(members[0].cookie, 'POST', `/api/projects/${id}/invites`, { role: 'editor' })).json.token;
  for (const m of members.slice(1)) await api(m.cookie, 'POST', `/api/invites/${inv}/accept`, {});
  rooms.push({ id, clients: await Promise.all(members.map((m) => connect(m.cookie, id))) });
}
for (const r of rooms) await new Promise((res) => { const t = setInterval(() => { if (r.clients.every((c) => c.files.get('README.md'))) { clearInterval(t); res(); } }, 20); });

const latencies = []; const started = Date.now();
await Promise.all(rooms.map(async (room) => {
  const [writer, ...readers] = room.clients; const text = writer.files.get('README.md');
  for (let k = 0; k < K; k++) {
    const marker = `#${k}|`; const t0 = performance.now(); text.insert(0, marker);
    await Promise.all(readers.map((rd) => new Promise((resolve) => { const check = () => { if (rd.files.get('README.md').toString().startsWith(marker) || rd.files.get('README.md').toString().includes(marker)) { latencies.push(performance.now() - t0); resolve(); } else setImmediate(check); }; check(); })));
    await sleep(50);
  }
}));
const secs = (Date.now() - started) / 1000;
console.log(`\n${latencies.length} edit deliveries across ${W * C} sockets in ${secs.toFixed(1)}s`);
console.log(`latency  p50=${percentile(latencies, 50).toFixed(1)}ms  p95=${percentile(latencies, 95).toFixed(1)}ms  p99=${percentile(latencies, 99).toFixed(1)}ms  max=${Math.max(...latencies).toFixed(1)}ms`);
console.log(`target   p95 < 150ms  =>  ${percentile(latencies, 95) < 150 ? 'PASS' : 'FAIL'}   (single process, same machine as the clients: indicative only)`);
for (const r of rooms) for (const c of r.clients) c.ws.close();
await app.close(); rmSync(dir, { recursive: true, force: true });
process.exit(percentile(latencies, 95) < 150 ? 0 : 1);
