// Compact edit history for Build Replay.
// Each entry stores a small patch against the previous content of the same file, with a full-content checkpoint every
// CHECKPOINT_EVERY edits per file. Legacy entries that only have `content` keep working.
const CHECKPOINT_EVERY = 40;
export const MAX_ENTRIES = 20000;
const TRIM_SLACK = 500;
const caches = new WeakMap(); // list -> { last: Map(path -> content), since: Map(path -> edits since checkpoint) }

const applyPatch = (prev, p) => prev.slice(0, p.s) + p.i + prev.slice(p.s + p.d);
function diffPatch(prev, next) {
  let s = 0; const max = Math.min(prev.length, next.length); while (s < max && prev[s] === next[s]) s++;
  let a = prev.length; let b = next.length; while (a > s && b > s && prev[a - 1] === next[b - 1]) { a--; b--; }
  return { s, d: a - s, i: next.slice(s, b) };
}

/** Rebuild path -> content for entries [0..upTo]. */
export function reconstruct(list, upTo = list.length - 1) {
  const files = {};
  for (let k = 0; k <= Math.min(upTo, list.length - 1); k++) { const e = list[k]; if (e.deleted) { delete files[e.path]; continue; } files[e.path] = e.patch ? applyPatch(files[e.path] ?? '', e.patch) : e.content; }
  return files;
}

function cacheFor(list) {
  let c = caches.get(list); if (c && c.length === list.length) return c;
  const last = new Map(); const since = new Map();
  for (const e of list) { if (e.deleted) { last.delete(e.path); since.set(e.path, 0); continue; } const v = e.patch ? applyPatch(last.get(e.path) ?? '', e.patch) : e.content; last.set(e.path, v); since.set(e.path, e.patch ? (since.get(e.path) || 0) + 1 : 0); }
  c = { last, since, length: list.length }; caches.set(list, c); return c;
}

export function appendHistory(list, entry) {
  const c = cacheFor(list); const prev = c.last.get(entry.path); const content = entry.content;
  if (content === null || content === undefined) { // deletion
    const gone = { id: entry.id, path: entry.path, actor: entry.actor, kind: 'file_deleted', createdAt: entry.createdAt, size: 0, added: 0, delta: -(prev ?? '').length, deleted: true, ...(entry.uid ? { uid: entry.uid } : {}) };
    list.push(gone); c.last.delete(entry.path); c.since.set(entry.path, 0); c.length = list.length; return gone;
  }
  const stored = { id: entry.id, path: entry.path, actor: entry.actor, kind: entry.kind, createdAt: entry.createdAt, size: content.length, ...(entry.uid ? { uid: entry.uid } : {}) };
  const sinceCp = c.since.get(entry.path) || 0; let patch = null;
  if (prev !== undefined && sinceCp < CHECKPOINT_EVERY) { patch = diffPatch(prev, content); if (patch.i.length + 20 >= content.length) patch = null; }
  stored.added = patch ? patch.i.length : Math.max(0, content.length - (prev ?? '').length);
  stored.delta = content.length - (prev ?? '').length;
  if (patch) stored.patch = patch; else stored.content = content;
  list.push(stored); c.last.set(entry.path, content); c.since.set(entry.path, patch ? sinceCp + 1 : 0); c.length = list.length;
  if (list.length > MAX_ENTRIES + TRIM_SLACK) trim(list);
  return stored;
}

/** Drop the oldest entries but keep every remaining file reconstructable (the first kept entry per file becomes a full snapshot). */
export function trim(list, keep = MAX_ENTRIES) {
  const drop = list.length - keep; if (drop <= 0) return; const files = reconstruct(list, drop - 1); const seen = new Set();
  const kept = list.slice(drop);
  for (const e of kept) { if (e.deleted) { delete files[e.path]; continue; } const base = files[e.path]; const value = e.patch ? applyPatch(base ?? '', e.patch) : e.content; files[e.path] = value; if (!seen.has(e.path)) { seen.add(e.path); if (e.patch) { delete e.patch; e.content = value; } } }
  list.length = 0; list.push(...kept); caches.delete(list);
}
