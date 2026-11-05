// Project overview, bulk import (files / folder / zip / GitHub), file tree operations, and ZIP export.
import { zipSync, strToU8 } from 'fflate';
import { can, workspaceRole } from './policy.mjs';
import { languageBreakdown, languageOf } from './langs.mjs';
import { isAlwaysSkipped, isSensitivePath, scanSecrets } from './secrets.mjs';
import { actorKind, actorLabel } from './judging.mjs';

export const LIMITS = { filesPerRequest: 300, fileBytes: 500_000, workspaceFiles: 3000, workspaceBytes: 50_000_000, githubFiles: 400 };
const README_NAMES = ['readme.md', 'readme.markdown', 'readme.txt', 'readme'];

export function cleanPath(value) {
  let p = String(value ?? '').replaceAll('\\', '/').replace(/^(\.\/)+/, '').replace(/\/{2,}/g, '/').replace(/\/$/, '');
  if (!p || p.length > 300 || p.includes('\0') || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null;
  const parts = p.split('/'); if (parts.some((s) => s === '..' || s === '.' || s === '')) return null; return p;
}

export function createProjects({ db, json, fail, audit, activity, collab, save, project, githubTokenFor, importLimiter }) {
  const need = (user, id, action) => { const p = project(id); if (!p || workspaceRole(p, user) === null) throw fail(404, 'Project not found'); if (!can(user, action, p)) throw fail(403, p.frozen && action === 'workspace.write' ? 'This workspace is frozen (the event deadline has passed)' : 'You do not have permission to do that'); return p; };
  const totalBytes = (files) => Object.values(files).reduce((n, c) => n + Buffer.byteLength(c || '', 'utf8'), 0);

  /** Decide which uploaded files to accept. Never throws; returns { accepted: [[path, content]], skipped: [{path, reason}], warnings }. */
  function screen(p, incoming, { overwrite = false } = {}) {
    const accepted = []; const skipped = []; const warnings = []; const seen = new Set();
    for (const raw of incoming) {
      const path = cleanPath(raw?.path); const label = String(raw?.path ?? '').slice(0, 120);
      if (!path) { skipped.push({ path: label, reason: 'unsafe or invalid path' }); continue; }
      if (seen.has(path)) { skipped.push({ path, reason: 'duplicate in this upload' }); continue; } seen.add(path);
      if (typeof raw.content !== 'string') { skipped.push({ path, reason: 'not a text file' }); continue; }
      if (isSensitivePath(path)) { skipped.push({ path, reason: 'looks like a secrets file (.env, key); not imported' }); continue; }
      if (isAlwaysSkipped(path)) { skipped.push({ path, reason: 'ignored (node_modules, .git, build output or binary type)' }); continue; }
      if (raw.content.includes('\0')) { skipped.push({ path, reason: 'binary file' }); continue; }
      if (Buffer.byteLength(raw.content, 'utf8') > LIMITS.fileBytes) { skipped.push({ path, reason: `larger than ${LIMITS.fileBytes / 1000} KB` }); continue; }
      if (p.files[path] !== undefined && !overwrite) { skipped.push({ path, reason: 'already exists (tick "replace existing files" to overwrite)' }); continue; }
      const content = raw.content.replace(/\r\n/g, '\n'); const found = scanSecrets(content); if (found.length) warnings.push({ path, issue: `contains what looks like: ${found.join(', ')}` });
      accepted.push([path, content]);
    }
    return { accepted, skipped, warnings };
  }
  function commitImport(p, user, accepted, label) {
    const existing = Object.keys(p.files).length; const newFiles = accepted.filter(([path]) => p.files[path] === undefined).length;
    if (existing + newFiles > LIMITS.workspaceFiles) throw fail(413, `A workspace can hold ${LIMITS.workspaceFiles} files`);
    if (totalBytes(p.files) + accepted.reduce((n, [, c]) => n + Buffer.byteLength(c, 'utf8'), 0) > LIMITS.workspaceBytes) throw fail(413, 'This would exceed the 50 MB workspace limit');
    if (accepted.length) { collab.writeFiles(p, accepted, `${user.name} (import)`, 'import', user.id); activity(user, 'imported', p.name, `${accepted.length} file${accepted.length === 1 ? '' : 's'} ${label}`, p.id); audit(user, 'project.import', p.id, `${accepted.length} files ${label}`); save(); }
  }

  const readmeOf = (files) => { const root = Object.keys(files).filter((f) => !f.includes('/')); const hit = README_NAMES.map((n) => root.find((f) => f.toLowerCase() === n)).find(Boolean); return hit ? { path: hit, content: files[hit] } : null; };

  function contributors(p) {
    const history = db.history[p.id] || []; const rows = new Map(); let agentRow = null; let total = 0;
    for (const e of history) {
      if (e.kind === 'file_deleted' && false) continue; total++;
      if (actorKind(e) === 'agent') { agentRow ||= { agent: true, name: 'AI agents', edits: 0, additions: 0, lastAt: 0 }; agentRow.edits++; agentRow.additions += e.added || 0; agentRow.lastAt = Math.max(agentRow.lastAt, e.createdAt); continue; }
      const byId = e.uid && db.users.find((u) => u.id === e.uid); const byName = !byId && db.users.find((u) => p.members[u.id] && u.name === actorLabel(e).replace(/ \(import\)$| \(Local Bridge\)$/, ''));
      const user = byId || byName; const key = user ? user.id : `name:${actorLabel(e)}`;
      const row = rows.get(key) || { id: user?.id || null, username: user?.username || null, name: user?.name || actorLabel(e), initials: user?.initials || actorLabel(e).slice(0, 2).toUpperCase(), avatar: user?.avatar || '', edits: 0, additions: 0, lastAt: 0 };
      row.edits++; row.additions += e.added || 0; row.lastAt = Math.max(row.lastAt, e.createdAt); rows.set(key, row);
    }
    for (const [uid, role] of Object.entries(p.members)) { const u = db.users.find((x) => x.id === uid); if (u && !rows.has(uid)) rows.set(uid, { id: uid, username: u.username, name: u.name, initials: u.initials, avatar: u.avatar || '', edits: 0, additions: 0, lastAt: 0 }); const row = rows.get(uid); if (row) row.role = role; }
    const list = [...rows.values()]; if (agentRow) list.push(agentRow);
    return list.map((r) => ({ ...r, share: total ? Math.round((r.edits / total) * 1000) / 10 : 0 })).sort((a, b) => b.edits - a.edits || a.name.localeCompare(b.name));
  }

  async function githubJson(url, token, signal) {
    const res = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'HackConnect', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal });
    if (res.status === 404) throw Object.assign(new Error('Repository not found. If it is private, click Connections > Connect GitHub first.'), { status: 404 });
    if (res.status === 403 || res.status === 429) throw Object.assign(new Error('GitHub is rate limiting this request. Connect your GitHub account (Connections) for a higher limit, or try again later.'), { status: 429 });
    if (!res.ok) throw Object.assign(new Error(`GitHub answered ${res.status}`), { status: 502 }); return res.json();
  }

  return async function handle({ req, res, user, parts, body }) {
    const sub = parts[3]; const method = req.method; const url = new URL(req.url, 'http://x');
    if (sub === 'overview' && method === 'GET') {
      const p = need(user, parts[2], 'workspace.read'); const history = db.history[p.id] || []; const langs = languageBreakdown(p.files);
      const lines = Object.values(p.files).reduce((n, c) => n + (c ? c.split('\n').length : 0), 0); const people = contributors(p);
      return json(res, 200, {
        project: { id: p.id, name: p.name, description: p.description, createdAt: p.createdAt, role: workspaceRole(p, user), eventId: p.eventId || null, frozen: Boolean(p.frozen), agentApproval: p.agentApproval || 'ask' },
        readme: readmeOf(p.files), languages: langs, totals: { files: Object.keys(p.files).length, lines, bytes: totalBytes(p.files) }, contributors: people,
        updatedAt: history.length ? history[history.length - 1].createdAt : p.createdAt, commits: history.length,
        members: Object.entries(p.members).map(([id, role]) => { const u = db.users.find((x) => x.id === id); return { id, role, username: u?.username, name: u?.name, initials: u?.initials }; }),
        activity: db.activity.filter((a) => a.projectId === p.id).slice(0, 8)
      }), true;
    }
    if (sub === 'tree' && method === 'GET') { const p = need(user, parts[2], 'workspace.read'); return json(res, 200, { files: Object.entries(p.files).sort(([a], [b]) => a.localeCompare(b)).map(([path, c]) => ({ path, size: Buffer.byteLength(c || '', 'utf8'), language: languageOf(path)?.name || null })) }), true; }
    if (sub === 'file' && method === 'GET') { const p = need(user, parts[2], 'workspace.read'); const path = cleanPath(url.searchParams.get('path')); if (!path || p.files[path] === undefined) return json(res, 404, { error: 'File not found' }), true; return json(res, 200, { path, content: p.files[path], language: languageOf(path)?.name || null, size: Buffer.byteLength(p.files[path], 'utf8') }), true; }
    if (sub === 'export.zip' && method === 'GET') {
      const p = need(user, parts[2], 'workspace.read'); const entries = {}; for (const [path, content] of Object.entries(p.files)) entries[path] = strToU8(content || ''); if (!Object.keys(entries).length) entries['README.md'] = strToU8(`# ${p.name}\n`);
      const zip = Buffer.from(zipSync(entries, { level: 6 })); const name = String(p.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project'; audit(user, 'project.export', p.id);
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${name}.zip"`, 'content-length': zip.length, 'cache-control': 'no-store' }); res.end(zip); return true;
    }
    if (sub === 'import' && method === 'POST') {
      const p = need(user, parts[2], 'workspace.write'); if (!Array.isArray(body.files) || !body.files.length) return json(res, 400, { error: 'Choose some files to import' }), true;
      if (body.files.length > LIMITS.filesPerRequest) return json(res, 413, { error: `Send at most ${LIMITS.filesPerRequest} files per request` }), true;
      const { accepted, skipped, warnings } = screen(p, body.files, { overwrite: body.overwrite === true }); commitImport(p, user, accepted, 'uploaded');
      return json(res, 200, { imported: accepted.length, skipped, warnings, totalFiles: Object.keys(p.files).length }), true;
    }
    if (sub === 'import-github' && method === 'POST') {
      const p = need(user, parts[2], 'workspace.write'); if (!importLimiter(`gh-import:${user.id}`)) return json(res, 429, { error: 'Slow down: a few imports per minute at most' }), true;
      const owner = String(body.owner || '').trim(); const repo = String(body.repo || '').trim().replace(/\.git$/, ''); const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
      if (!NAME.test(owner) || !NAME.test(repo)) return json(res, 400, { error: 'Enter a GitHub owner and repository name' }), true; if (body.branch && !/^[\w./-]{1,100}$/.test(String(body.branch))) return json(res, 400, { error: 'Invalid branch name' }), true;
      const api = (process.env.HACKCONNECT_GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''); const token = githubTokenFor(user); const signal = () => AbortSignal.timeout(15000);
      try {
        const info = await githubJson(`${api}/repos/${owner}/${repo}`, token, signal()); const branch = String(body.branch || info.default_branch || 'main');
        const tree = await githubJson(`${api}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, token, signal());
        const wanted = (tree.tree || []).filter((n) => n.type === 'blob' && cleanPath(n.path) && !isAlwaysSkipped(n.path) && !isSensitivePath(n.path) && (n.size ?? 0) <= LIMITS.fileBytes && (n.size ?? 0) > 0).slice(0, LIMITS.githubFiles);
        const fetched = []; let next = 0;
        await Promise.all(Array.from({ length: 8 }, async () => { while (next < wanted.length) { const node = wanted[next++]; try { const blob = await githubJson(`${api}/repos/${owner}/${repo}/git/blobs/${node.sha}`, token, signal()); if (blob.encoding === 'base64') fetched.push({ path: node.path, content: Buffer.from(blob.content, 'base64').toString('utf8') }); } catch (error) { if (error.status === 429) throw error; } } }));
        const { accepted, skipped, warnings } = screen(p, fetched, { overwrite: body.overwrite === true }); commitImport(p, user, accepted, `from github.com/${owner}/${repo}`);
        return json(res, 200, { imported: accepted.length, skipped, warnings, repo: `${owner}/${repo}`, branch, truncated: Boolean(tree.truncated) || (tree.tree || []).filter((n) => n.type === 'blob').length > wanted.length, totalFiles: Object.keys(p.files).length }), true;
      } catch (error) { if (error.status) return json(res, error.status, { error: error.message }), true; if (error.name === 'TimeoutError') return json(res, 504, { error: 'GitHub took too long to answer' }), true; throw error; }
    }
    if (sub === 'files' && parts[4] === 'mkdir' && method === 'POST') {
      const p = need(user, parts[2], 'workspace.write'); const dir = cleanPath(body.path); if (!dir) return json(res, 400, { error: 'Enter a valid folder name' }), true;
      if (Object.keys(p.files).some((f) => f === dir)) return json(res, 409, { error: 'A file with that name already exists' }), true;
      collab.writeFiles(p, [[`${dir}/.gitkeep`, '']], user.name, 'file_created', user.id); save(); return json(res, 201, { path: dir }), true;
    }
    if (sub === 'files' && parts[4] === 'rename' && method === 'POST') {
      const p = need(user, parts[2], 'workspace.write'); const from = cleanPath(body.from); const to = cleanPath(body.to); if (!from || !to) return json(res, 400, { error: 'Enter valid names' }), true; if (from === to) return json(res, 200, { moved: 0 }), true;
      if (to.startsWith(`${from}/`)) return json(res, 400, { error: 'You cannot move a folder inside itself' }), true;
      const moves = Object.keys(p.files).filter((f) => f === from || f.startsWith(`${from}/`)).map((f) => [f, f === from ? to : `${to}${f.slice(from.length)}`]); if (!moves.length) return json(res, 404, { error: 'Nothing to rename there' }), true;
      if (moves.some(([, dest]) => p.files[dest] !== undefined && !moves.some(([src]) => src === dest))) return json(res, 409, { error: 'A file with that name already exists' }), true;
      collab.renamePaths(p, moves, user.name, user.id); audit(user, 'file.rename', p.id, `${from} -> ${to}`); save(); return json(res, 200, { moved: moves.length }), true;
    }
    if (sub === 'files' && method === 'DELETE') {
      const p = need(user, parts[2], 'workspace.write'); const path = cleanPath(url.searchParams.get('path')); if (!path) return json(res, 400, { error: 'Choose a file or folder' }), true;
      const folder = url.searchParams.get('folder') === '1'; const targets = Object.keys(p.files).filter((f) => f === path || (folder && f.startsWith(`${path}/`))); if (!targets.length) return json(res, 404, { error: 'Nothing to delete there' }), true;
      collab.deletePaths(p, targets, user.name, user.id); audit(user, 'file.delete', p.id, `${path} (${targets.length})`); save(); return json(res, 200, { deleted: targets.length }), true;
    }
    return false;
  };
}
