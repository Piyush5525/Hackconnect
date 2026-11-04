import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
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

const root = fileURLToPath(new URL('..', import.meta.url));
let app, base, dir;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hc-collab-'));
  app = createApp({ root, stateFile: join(dir, 'state.json'), authLimit: 1000 });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await sleep(20); } throw new Error('timed out waiting for condition'); };

const session = async (name, email) => {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]; return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  assert.equal((await call('POST', '/api/auth/signup', { name, email, password: 'correct-horse-battery' })).status, 201);
  return { call, get cookie() { return cookie; } };
};

// Node implementation of the same y-protocols client the browser uses.
const connect = (cookie, projectId) => new Promise((resolve) => {
  const doc = new Y.Doc(); const ws = new WebSocket(`${base.replace('http', 'ws')}/collab?projectId=${projectId}`, { headers: { cookie } }); ws.binaryType = 'nodebuffer';
  const c = { doc, ws, synced: false, closeCode: null, files: doc.getMap('files') };
  doc.on('update', (update, origin) => { if (origin === ws) return; const e = encoding.createEncoder(); encoding.writeVarUint(e, 0); syncProtocol.writeUpdate(e, update); if (ws.readyState === 1) ws.send(encoding.toUint8Array(e)); });
  ws.on('open', () => { const e = encoding.createEncoder(); encoding.writeVarUint(e, 0); syncProtocol.writeSyncStep1(e, doc); ws.send(encoding.toUint8Array(e)); });
  ws.on('message', (data) => {
    const d = decoding.createDecoder(new Uint8Array(data)); if (decoding.readVarUint(d) !== 0) return;
    const reply = encoding.createEncoder(); encoding.writeVarUint(reply, 0); const t = syncProtocol.readSyncMessage(d, reply, doc, ws);
    if (encoding.length(reply) > 1) ws.send(encoding.toUint8Array(reply)); if (t === syncProtocol.messageYjsSyncStep2 && !c.synced) { c.synced = true; resolve(c); }
  });
  ws.on('close', (code) => { c.closeCode = code; if (!c.synced) resolve(c); }); ws.on('error', () => {});
});

test('two writers typing concurrently converge to identical text', async () => {
  const a = await session('Ann A', 'ann@x.io'); const b = await session('Bo B', 'bo@x.io');
  const id = (await a.call('POST', '/api/projects', { name: 'Collab Room' })).body.id;
  const inv = await a.call('POST', `/api/projects/${id}/invites`, { role: 'editor' }); await b.call('POST', `/api/invites/${inv.body.token}/accept`, {});
  const ca = await connect(a.cookie, id); const cb = await connect(b.cookie, id);
  assert.ok(ca.synced && cb.synced);
  await until(() => ca.files.get('README.md') && cb.files.get('README.md'));
  const ta = ca.files.get('README.md'); const tb = cb.files.get('README.md');
  assert.equal(ta.toString(), tb.toString());
  // Concurrent edits at the same position, plus a new file and a delete
  for (let i = 0; i < 20; i++) { ta.insert(0, `A${i} `); tb.insert(0, `B${i} `); }
  ca.files.set('notes.md', new Y.Text('from ann'));
  await until(() => ta.toString() === tb.toString() && cb.files.get('notes.md')?.toString() === 'from ann');
  assert.match(ta.toString(), /A19/); assert.match(ta.toString(), /B19/);
  assert.equal(ta.toString().split(' ').filter((w) => /^[AB]\d+$/.test(w)).length, 40, 'no keystroke lost');
  // Persisted to the REST view / history (debounced)
  await until(() => app.db.projects.find((p) => p.id === id).files['notes.md'] === 'from ann', 4000);
  assert.equal((await a.call('GET', `/api/projects/${id}`)).body.project.files['README.md'], ta.toString());
  assert.ok(app.db.history[id].some((h) => h.path === 'notes.md' && h.kind === 'file_created'));
  ca.ws.close(); cb.ws.close();
});

test('viewers can read live but their edits are dropped', async () => {
  const o = await session('Own O', 'own@x.io'); const v = await session('View V', 'view@x.io');
  const id = (await o.call('POST', '/api/projects', { name: 'RO Room' })).body.id;
  const inv = await o.call('POST', `/api/projects/${id}/invites`, { role: 'viewer' }); await v.call('POST', `/api/invites/${inv.body.token}/accept`, {});
  const co = await connect(o.cookie, id); const cv = await connect(v.cookie, id);
  await until(() => cv.files.get('README.md'));
  cv.files.get('README.md').insert(0, 'HACKED ');
  co.files.get('README.md').insert(0, 'legit ');
  await until(() => cv.files.get('README.md').toString().includes('legit'));
  await sleep(200);
  assert.ok(!co.files.get('README.md').toString().includes('HACKED'), 'viewer edit must not reach the owner');
  co.ws.close(); cv.ws.close();
});

test('REST/agent writes appear live; outsiders and anonymous are refused; removal disconnects', async () => {
  const o = await session('Own2 O', 'own2@x.io'); const m = await session('Mem M', 'mem@x.io'); const x = await session('Out X', 'outx@x.io');
  const id = (await o.call('POST', '/api/projects', { name: 'Live Room' })).body.id;
  const inv = await o.call('POST', `/api/projects/${id}/invites`, { role: 'editor' }); await m.call('POST', `/api/invites/${inv.body.token}/accept`, {});
  assert.equal((await connect('', id)).closeCode, 4401);
  assert.equal((await connect(x.cookie, id)).closeCode, 4403);
  const cm = await connect(m.cookie, id); await until(() => cm.files.get('README.md'));
  await o.call('PUT', `/api/projects/${id}/files`, { path: 'src/app.js', content: 'console.log(1)' });
  await until(() => cm.files.get('src/app.js')?.toString() === 'console.log(1)');
  await o.call('PUT', `/api/projects/${id}/files`, { path: 'src/app.js', content: 'console.log(2)' });
  await until(() => cm.files.get('src/app.js')?.toString() === 'console.log(2)');
  const memberId = (await m.call('GET', '/api/auth/me')).body.user.id;
  await o.call('DELETE', `/api/projects/${id}/members/${memberId}`);
  await until(() => cm.closeCode === 4403);
});

test('document state survives a server restart', async () => {
  const stateFile = join(dir, 'restart.json');
  let a1 = createApp({ root, stateFile, authLimit: 1000 }); await new Promise((r) => a1.server.listen(0, '127.0.0.1', r));
  const b1 = `http://127.0.0.1:${a1.server.address().port}`;
  const post = async (b, cookie, path, body, method = 'POST') => { const res = await fetch(b + path, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }); return res; };
  const su = await post(b1, '', '/api/auth/signup', { name: 'Persist P', email: 'p@x.io', password: 'correct-horse-battery' }); const cookie = su.headers.get('set-cookie').split(';')[0];
  const id = (await (await post(b1, cookie, '/api/projects', { name: 'Persist' })).json()).id;
  await post(b1, cookie, `/api/projects/${id}/files`, { path: 'keep.txt', content: 'durable' }, 'PUT');
  await a1.close();
  const a2 = createApp({ root, stateFile, authLimit: 1000 }); await new Promise((r) => a2.server.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${a2.server.address().port}`;
  const res = await fetch(`${b2}/api/projects/${id}`, { headers: { cookie } }); assert.equal((await res.json()).project.files['keep.txt'], 'durable');
  base = b2; const c = await connect(cookie, id); await until(() => c.files.get('keep.txt')?.toString() === 'durable'); c.ws.close();
  await a2.close();
});
