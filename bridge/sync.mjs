// Local Bridge sync engine: two-way sync between a local folder and a workspace's Yjs document.
import { realpathSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, lstatSync, unlinkSync, watch, renameSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { compileIgnore, isAlwaysSkipped, isSensitivePath, scanSecrets } from '../lib/secrets.mjs';

const LOCAL = Symbol('local');
const REMOTE = 'remote';

export function applyTextDiff(ytext, oldValue, newValue, origin) {
  if (oldValue === newValue) return;
  let start = 0; const max = Math.min(oldValue.length, newValue.length);
  while (start < max && oldValue[start] === newValue[start]) start++;
  let endOld = oldValue.length; let endNew = newValue.length;
  while (endOld > start && endNew > start && oldValue[endOld - 1] === newValue[endNew - 1]) { endOld--; endNew--; }
  ytext.doc.transact(() => { if (endOld > start) ytext.delete(start, endOld - start); if (endNew > start) ytext.insert(start, newValue.slice(start, endNew)); }, origin);
}

export class BridgeSync {
  // The folder is resolved to its long canonical path: Windows 8.3 short names crash libuv's recursive watcher.
  constructor({ dir, server, token, workspaceId, agent = '', allowSecrets = false, allowSensitive = false, maxFileBytes = 1_000_000, log = () => {}, debounceMs = 120, onStatus = () => {} }) {
    this.dir = realpathSync.native(resolve(dir)); this.server = server.replace(/\/+$/, ''); this.token = token; this.workspaceId = workspaceId; this.agent = agent;
    this.allowSecrets = allowSecrets; this.allowSensitive = allowSensitive; this.maxFileBytes = maxFileBytes; this.log = log; this.debounceMs = debounceMs; this.onStatus = onStatus;
    this.doc = new Y.Doc(); this.files = this.doc.getMap('files'); this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.base = new Map(); this.written = new Map(); this.eol = new Map(); this.timers = new Map(); this.synced = false; this.stopped = false; this.watcher = null; this.ws = null; this.skipped = new Set();
    this.refreshIgnore();
  }

  refreshIgnore() {
    const read = (f) => { try { return readFileSync(join(this.dir, f), 'utf8'); } catch { return ''; } };
    this.isIgnored = compileIgnore(`${read('.gitignore')}\n${read('.hackconnectignore')}`);
  }
  shouldSync(rel) {
    if (rel === '.hackconnectignore' || rel === '.gitignore') return true; // harmless and useful to teammates
    if (isAlwaysSkipped(rel) || this.isIgnored(rel)) return false;
    if (!this.allowSensitive && isSensitivePath(rel)) { this.warnSkip(rel, 'looks like a secrets file'); return false; }
    return true;
  }
  warnSkip(rel, why) { if (!this.skipped.has(rel)) { this.skipped.add(rel); this.log(`skipped ${rel} (${why})`); } }

  // Remote paths come from other people: never let them escape the shared folder.
  localPath(rel) {
    if (!rel || rel.includes('\0') || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.split('/').includes('..')) return null;
    const full = resolve(this.dir, rel); if (full !== this.dir && !full.startsWith(this.dir + sep)) return null;
    let cur = dirname(full); while (cur.length > this.dir.length) { if (existsSync(cur) && lstatSync(cur).isSymbolicLink()) return null; cur = dirname(cur); }
    return full;
  }
  relOf(full) { return relative(this.dir, full).split(sep).join('/'); }

  readLocal(rel) {
    const full = this.localPath(rel); if (!full || !existsSync(full)) return null;
    const st = statSync(full); if (!st.isFile()) return null;
    if (st.size > this.maxFileBytes) { this.warnSkip(rel, `larger than ${Math.round(this.maxFileBytes / 1000)} KB`); return null; }
    const buf = readFileSync(full); if (buf.includes(0)) { this.warnSkip(rel, 'binary file'); return null; }
    const text = buf.toString('utf8'); this.eol.set(rel, text.includes('\r\n') ? '\r\n' : '\n'); return text.replace(/\r\n/g, '\n');
  }
  writeLocal(rel, content) {
    const full = this.localPath(rel); if (!full) { this.log(`ignored unsafe remote path ${JSON.stringify(rel)}`); return; }
    const out = (this.eol.get(rel) || '\n') === '\r\n' ? content.replace(/\n/g, '\r\n') : content;
    mkdirSync(dirname(full), { recursive: true }); this.written.set(rel, content); const tmp = `${full}.hc-tmp`; writeFileSync(tmp, out); renameSync(tmp, full); this.base.set(rel, content);
  }
  walk(dir = this.dir, out = []) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name); const rel = this.relOf(full); const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { if (!isAlwaysSkipped(`${rel}/x`) && !this.isIgnored(`${rel}/`)) this.walk(full, out); } else if (st.isFile() && this.shouldSync(rel)) out.push(rel);
    }
    return out;
  }

  pushLocal(rel, content) {
    if (!this.allowSecrets) { const found = scanSecrets(content); if (found.length) { this.warnSkip(rel, `possible secret: ${found.join(', ')} — use --allow-secrets to override`); return false; } }
    let text = this.files.get(rel);
    if (!text) { text = new Y.Text(); this.files.set(rel, text); }
    applyTextDiff(text, text.toString(), content, LOCAL); this.base.set(rel, content); return true;
  }

  reconcile() {
    const local = new Set(this.walk()); const remote = new Set(this.files.keys());
    for (const rel of new Set([...local, ...remote])) {
      if (!this.shouldSync(rel)) continue;
      const l = local.has(rel) ? this.readLocal(rel) : null; const r = remote.has(rel) ? this.files.get(rel).toString() : null; const b = this.base.get(rel);
      if (l === null && r !== null) this.writeLocal(rel, r);
      else if (l !== null && r === null) this.pushLocal(rel, l);
      else if (l !== null && r !== null) {
        if (l === r) { this.base.set(rel, l); continue; }
        const localChanged = b === undefined || l !== b; const remoteChanged = b === undefined || r !== b;
        if (localChanged && !remoteChanged) this.pushLocal(rel, l);
        else if (!localChanged && remoteChanged) this.writeLocal(rel, r);
        else { // both sides differ: never overwrite silently; keep the local version as a backup
          const backup = this.localPath(`${rel}.hc-local-backup`); if (backup) writeFileSync(backup, l);
          this.log(`CONFLICT in ${rel}: kept your version as ${rel}.hc-local-backup and applied the team's version`); this.writeLocal(rel, r);
        }
      }
    }
  }

  onLocalEvent(rel) {
    if (this.stopped || !this.shouldSync(rel)) return;
    clearTimeout(this.timers.get(rel));
    this.timers.set(rel, setTimeout(() => { this.timers.delete(rel); try { this.handleLocal(rel); } catch (e) { this.log(`error syncing ${rel}: ${e.message}`); } }, this.debounceMs));
  }
  handleLocal(rel) {
    if (rel === '.gitignore' || rel === '.hackconnectignore') this.refreshIgnore();
    const full = this.localPath(rel); if (!full) return;
    if (!existsSync(full)) { if (this.synced && this.base.has(rel) && this.files.has(rel)) { this.doc.transact(() => this.files.delete(rel), LOCAL); this.base.delete(rel); this.log(`deleted ${rel}`); } return; }
    const content = this.readLocal(rel); if (content === null) return;
    if (this.written.get(rel) === content) { this.written.delete(rel); return; } // our own write: do not echo it back
    if (!this.synced) return; if (this.pushLocal(rel, content)) this.log(`↑ ${rel}`);
  }

  pathOfText(target) { for (const [rel, t] of this.files.entries()) if (t === target) return rel; return null; }
  onRemote(events, tr) {
    if (tr.origin === LOCAL || !this.synced) return;
    const changed = new Set();
    for (const ev of events) { if (ev.target === this.files) for (const k of ev.keysChanged) changed.add(k); else { const rel = this.pathOfText(ev.target); if (rel) changed.add(rel); } }
    for (const rel of changed) {
      if (!this.shouldSync(rel)) continue;
      const text = this.files.get(rel);
      if (!text) { const full = this.localPath(rel); if (full && existsSync(full)) { const cur = this.readLocal(rel); if (cur === this.base.get(rel)) { unlinkSync(full); this.base.delete(rel); this.log(`↓ removed ${rel}`); } else this.log(`kept ${rel}: deleted by a teammate but you changed it locally`); } continue; }
      const content = text.toString(); if (this.written.get(rel) !== content) { this.writeLocal(rel, content); this.log(`↓ ${rel}`); }
    }
  }

  send(build) { if (this.ws?.readyState === 1) { const e = encoding.createEncoder(); build(e); this.ws.send(encoding.toUint8Array(e)); } }
  start() {
    this.doc.on('update', (update, origin) => { if (origin === REMOTE) return; this.send((e) => { encoding.writeVarUint(e, 0); syncProtocol.writeUpdate(e, update); }); });
    this.files.observeDeep((events, tr) => this.onRemote(events, tr));
    this.awareness.setLocalStateField('user', { id: 'bridge', name: this.agent ? `${this.agent} (bridge)` : 'Local Bridge', color: '#9ccfd8' });
    this.awareness.on('update', ({ added, updated, removed }, origin) => { if (origin !== REMOTE) this.send((e) => { encoding.writeVarUint(e, 1); encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, added.concat(updated, removed))); }); });
    this.connect();
    this.watcher = watch(this.dir, { recursive: true }, (_ev, name) => { if (name) this.onLocalEvent(String(name).split(sep).join('/')); });
    this.watcher.on('error', (e) => this.log(`watcher error: ${e.message}`));
  }
  connect() {
    if (this.stopped) return; this.onStatus('connecting');
    const headers = { authorization: `Bearer ${this.token}` }; if (this.agent) headers['x-hc-agent'] = this.agent;
    const ws = (this.ws = new WebSocket(`${this.server.replace(/^http/, 'ws')}/collab?projectId=${encodeURIComponent(this.workspaceId)}`, { headers })); ws.binaryType = 'nodebuffer';
    ws.on('open', () => { this.send((e) => { encoding.writeVarUint(e, 0); syncProtocol.writeSyncStep1(e, this.doc); }); this.send((e) => { encoding.writeVarUint(e, 1); encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID])); }); });
    ws.on('message', (data) => {
      const d = decoding.createDecoder(new Uint8Array(data)); const type = decoding.readVarUint(d);
      if (type === 0) {
        const reply = encoding.createEncoder(); encoding.writeVarUint(reply, 0); const t = syncProtocol.readSyncMessage(d, reply, this.doc, REMOTE);
        if (encoding.length(reply) > 1) ws.send(encoding.toUint8Array(reply));
        if (t === syncProtocol.messageYjsSyncStep2 && !this.synced) { this.synced = true; try { this.reconcile(); } catch (e) { this.log(`initial sync error: ${e.message}`); } this.onStatus('sharing'); }
      }
    });
    ws.on('close', (code) => { this.synced = false; if (this.stopped) return; if (code === 4401 || code === 4403) { this.onStatus('denied'); this.log('Access denied. Run `hackconnect login` again or check your role.'); return; } this.onStatus('reconnecting'); this.retry = setTimeout(() => this.connect(), 1500); });
    ws.on('error', () => {});
  }
  stop() { this.stopped = true; clearTimeout(this.retry); for (const t of this.timers.values()) clearTimeout(t); this.watcher?.close(); this.awareness.destroy(); this.ws?.close(); this.onStatus('stopped'); }
}
