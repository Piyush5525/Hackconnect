// Yjs collaboration: one Y.Doc per workspace, synced over binary WebSocket frames.
// Doc layout: Y.Map "files" of path -> Y.Text. Viewers may read/sync but their updates are dropped.
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const PERSIST_DELAY_MS = 500;

export function createCollab({ db, recordHistory, save }) {
  const docs = new Map(); // projectId -> entry

  const getEntry = (item) => {
    let entry = docs.get(item.id); if (entry) return entry;
    const doc = new Y.Doc(); const files = doc.getMap('files');
    db.yjs ||= {};
    if (db.yjs[item.id]) Y.applyUpdate(doc, Buffer.from(db.yjs[item.id], 'base64'), 'persist');
    // Reconcile with item.files (REST writes or legacy data not yet in the doc).
    doc.transact(() => {
      for (const [path, content] of Object.entries(item.files)) {
        let text = files.get(path); if (!text) { text = new Y.Text(); files.set(path, text); }
        if (text.toString() !== content && text.length === 0) text.insert(0, content);
      }
    }, 'persist');
    entry = { doc, files, awareness: new awarenessProtocol.Awareness(doc), conns: new Set(), timer: null, lastActor: 'unknown', lastKind: 'edit', lastUid: null, item };
    entry.awareness.setLocalState(null);
    doc.on('update', (update, origin) => {
      if (origin !== 'persist') { if (origin?.user?.id) entry.lastUid = origin.user.id; entry.lastActor = origin?.meta?.label || origin?.user?.name || (typeof origin === 'string' ? origin : entry.lastActor); entry.lastKind = origin?.meta?.kind === 'agent' ? 'agent_edit' : origin?.meta?.kind === 'bridge' ? 'bridge_edit' : 'edit'; schedulePersist(entry); }
      const encoder = encoding.createEncoder(); encoding.writeVarUint(encoder, MSG_SYNC); syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);
      for (const conn of entry.conns) if (conn !== origin) send(conn, message);
    });
    entry.awareness.on('update', ({ added, updated, removed }, origin) => {
      const changed = added.concat(updated, removed);
      if (origin && origin.awarenessIds) { for (const id of added) origin.awarenessIds.add(id); for (const id of removed) origin.awarenessIds.delete(id); }
      const encoder = encoding.createEncoder(); encoding.writeVarUint(encoder, MSG_AWARENESS);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(entry.awareness, changed));
      const message = encoding.toUint8Array(encoder); for (const conn of entry.conns) send(conn, message);
    });
    docs.set(item.id, entry); return entry;
  };

  const send = (conn, message) => { if (conn.readyState === 1) conn.send(message, { binary: true }); };

  const persist = (entry) => {
    if (entry.timer) clearTimeout(entry.timer); entry.timer = null; const { item, files, doc } = entry;
    const live = {};
    for (const [path, text] of files.entries()) live[path] = text.toString();
    for (const [path, content] of Object.entries(live)) {
      if (item.files[path] !== content) { recordHistory(item, path, content, entry.lastActor, entry.lastKind !== 'edit' ? entry.lastKind : item.files[path] === undefined ? 'file_created' : 'edit', entry.lastUid); item.files[path] = content; }
    }
    for (const path of Object.keys(item.files)) if (!(path in live)) { recordHistory(item, path, null, entry.lastActor, 'file_deleted', entry.lastUid); delete item.files[path]; }
    db.yjs[item.id] = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'); entry.lastKind = 'edit'; save();
  };
  const schedulePersist = (entry) => { if (!entry.destroyed && !entry.timer) entry.timer = setTimeout(() => persist(entry), PERSIST_DELAY_MS); };

  /** Attach an authenticated socket. `canWrite()` is re-evaluated on every frame so role changes apply immediately. */
  function attach(socket, item, user, canWrite, meta = null) {
    const entry = getEntry(item); socket.user = user; socket.meta = meta; socket.awarenessIds = new Set(); socket.binaryType = 'nodebuffer';
    entry.conns.add(socket);
    // server -> client sync step 1 + current awareness
    const hello = encoding.createEncoder(); encoding.writeVarUint(hello, MSG_SYNC); syncProtocol.writeSyncStep1(hello, entry.doc); send(socket, encoding.toUint8Array(hello));
    const states = entry.awareness.getStates(); if (states.size) { const e = encoding.createEncoder(); encoding.writeVarUint(e, MSG_AWARENESS); encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(entry.awareness, [...states.keys()])); send(socket, encoding.toUint8Array(e)); }
    socket.on('message', (data) => {
      try {
        const decoder = decoding.createDecoder(new Uint8Array(data)); const type = decoding.readVarUint(decoder);
        if (type === MSG_SYNC) {
          const reply = encoding.createEncoder(); encoding.writeVarUint(reply, MSG_SYNC);
          const syncType = decoding.readVarUint(decoder);
          if (syncType === syncProtocol.messageYjsSyncStep1) syncProtocol.readSyncStep1(decoder, reply, entry.doc);
          else if (canWrite()) { // step2 / update carry document changes
            if (syncType === syncProtocol.messageYjsSyncStep2) syncProtocol.readSyncStep2(decoder, entry.doc, socket); else if (syncType === syncProtocol.messageYjsUpdate) syncProtocol.readUpdate(decoder, entry.doc, socket);
          }
          if (encoding.length(reply) > 1) send(socket, encoding.toUint8Array(reply));
        } else if (type === MSG_AWARENESS) {
          awarenessProtocol.applyAwarenessUpdate(entry.awareness, decoding.readVarUint8Array(decoder), socket);
        }
      } catch { socket.close(1003, 'Bad collab frame'); }
    });
    socket.on('close', () => {
      entry.conns.delete(socket); awarenessProtocol.removeAwarenessStates(entry.awareness, [...socket.awarenessIds], null);
      if (!entry.conns.size) { if (entry.timer) { clearTimeout(entry.timer); persist(entry); } }
    });
  }

  /** Server-side write (REST, agent) routed through the Y.Doc so every client sees it live. */
  const applyContent = (files, path, content) => {
    let text = files.get(path); if (!text) { text = new Y.Text(); files.set(path, text); }
    const old = text.toString(); if (old === content) return;
    let start = 0; const max = Math.min(old.length, content.length);
    while (start < max && old[start] === content[start]) start++;
    let endOld = old.length, endNew = content.length;
    while (endOld > start && endNew > start && old[endOld - 1] === content[endNew - 1]) { endOld--; endNew--; }
    if (endOld > start) text.delete(start, endOld - start); if (endNew > start) text.insert(start, content.slice(start, endNew));
  };
  /** Write many files in one transaction and one persist (bulk import). */
  function writeFiles(item, list, actor, kind = 'edit', uid = null) {
    const entry = getEntry(item); entry.doc.transact(() => { for (const [path, content] of list) applyContent(entry.files, path, content); }, actor);
    entry.lastActor = actor; entry.lastKind = kind; entry.lastUid = uid; persist(entry);
  }
  function deletePaths(item, paths, actor, uid = null) {
    const entry = getEntry(item); entry.doc.transact(() => { for (const p of paths) entry.files.delete(p); }, actor); entry.lastActor = actor; entry.lastKind = 'edit'; entry.lastUid = uid; persist(entry);
  }
  function renamePaths(item, moves, actor, uid = null) { // moves: [[from, to], ...]
    const entry = getEntry(item); entry.doc.transact(() => { for (const [from, to] of moves) { const text = entry.files.get(from); if (!text) continue; const content = text.toString(); entry.files.delete(from); entry.files.set(to, new Y.Text(content)); } }, actor); entry.lastActor = actor; entry.lastKind = 'edit'; entry.lastUid = uid; persist(entry);
  }
  function writeFile(item, path, content, actor, kind = 'edit', uid = null) {
    const entry = getEntry(item); const { doc, files } = entry; entry.lastUid = uid;
    doc.transact(() => {
      let text = files.get(path); if (!text) { text = new Y.Text(); files.set(path, text); }
      const old = text.toString(); if (old === content) return;
      let start = 0; const max = Math.min(old.length, content.length);
      while (start < max && old[start] === content[start]) start++;
      let endOld = old.length, endNew = content.length;
      while (endOld > start && endNew > start && old[endOld - 1] === content[endNew - 1]) { endOld--; endNew--; }
      if (endOld > start) text.delete(start, endOld - start); if (endNew > start) text.insert(start, content.slice(start, endNew));
    }, actor);
    entry.lastActor = actor; entry.lastKind = kind; persist(entry);
  }

  /** Flush everything (used on shutdown/tests). */
  function flush() { for (const entry of docs.values()) if (entry.timer) { clearTimeout(entry.timer); persist(entry); } }
  function kick(projectId, userId) { for (const conn of docs.get(projectId)?.conns || []) if (conn.user.id === userId) conn.close(4403, 'Access revoked'); }
  function destroy() { flush(); for (const entry of docs.values()) { entry.destroyed = true; if (entry.timer) clearTimeout(entry.timer); entry.timer = null; entry.awareness.destroy(); entry.doc.destroy(); } docs.clear(); }
  function drop(projectId) { docs.delete(projectId); }

  return { attach, writeFile, writeFiles, deletePaths, renamePaths, flush, destroy, kick, drop };
}
