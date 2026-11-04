import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { createApp } from '../lib/app.mjs';
import { languageBreakdown, languageOf } from '../lib/langs.mjs';
import { cleanPath } from '../lib/projects.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
let app, base, dir, gh, ghBase; const ghCalls = [];
before(async () => {
  gh = http.createServer((req, res) => {
    ghCalls.push(req.url); const send = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); }; const b64 = (t) => Buffer.from(t).toString('base64');
    if (req.url === '/repos/octo/hello') return send(200, { default_branch: 'trunk' });
    if (req.url === '/repos/octo/private') return send(404, {}); if (req.url === '/repos/octo/limited') return send(403, {});
    if (req.url.startsWith('/repos/octo/hello/git/trees/trunk')) return send(200, { truncated: false, tree: [{ type: 'blob', path: 'README.md', sha: 'r1', size: 20 }, { type: 'blob', path: 'src/main.py', sha: 'p1', size: 30 }, { type: 'blob', path: '.env', sha: 'e1', size: 9 }, { type: 'blob', path: 'node_modules/x/i.js', sha: 'n1', size: 5 }, { type: 'blob', path: 'logo.png', sha: 'l1', size: 99 }, { type: 'tree', path: 'src', sha: 't' }, { type: 'blob', path: 'big.txt', sha: 'b1', size: 900000 }] });
    const blob = /\/git\/blobs\/(\w+)/.exec(req.url)?.[1]; const data = { r1: '# Hello\nFrom GitHub\n', p1: 'print("hi from github")\n' }[blob]; if (data) return send(200, { encoding: 'base64', content: b64(data) }); send(404, {});
  });
  await new Promise((r) => gh.listen(0, '127.0.0.1', r)); ghBase = `http://127.0.0.1:${gh.address().port}`; process.env.HACKCONNECT_GITHUB_API_URL = ghBase;
  dir = mkdtempSync(join(tmpdir(), 'hc-proj-')); app = createApp({ root, stateFile: join(dir, 's.json'), authLimit: 1e6, autoBackupMinutes: 0 }); await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => { delete process.env.HACKCONNECT_GITHUB_API_URL; await app.close(); gh.closeAllConnections?.(); await new Promise((r) => gh.close(r)); rmSync(dir, { recursive: true, force: true }); });

const person = async (name, email, username) => { let cookie = ''; const call = async (method, path, body, raw = false) => { const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const set = res.headers.get('set-cookie'); if (set && /hc_session/.test(set)) cookie = set.split(';')[0]; if (raw) return res; return { status: res.status, body: await res.json().catch(() => ({})) }; }; const r = await call('POST', '/api/auth/signup', { name, email, username, password: 'correct-horse-battery' }); return { call, id: r.body.user.id }; };
const f = (path, content) => ({ path, content });

test('language detection is GitHub-style: programming + markup by bytes, prose and data excluded', () => {
  assert.equal(languageOf('a/b/App.tsx').name, 'TypeScript'); assert.equal(languageOf('Dockerfile').name, 'Dockerfile'); assert.equal(languageOf('x.unknown'), null);
  const b = languageBreakdown({ 'a.py': 'x'.repeat(750), 'b.js': 'y'.repeat(250), 'README.md': 'z'.repeat(5000), 'data.json': '{}'.repeat(500), 'empty.py': '' });
  assert.deepEqual(b.map((r) => [r.language, r.percent]), [['Python', 75], ['JavaScript', 25]]); assert.equal(b[0].color, '#3572A5'); assert.equal(b[0].files, 1);
  assert.deepEqual(languageBreakdown({}), []);
  for (const bad of ['../x', '/etc/passwd', 'C:\\x', 'a/../b', '', 'a\0b', './', 'a/./b']) assert.equal(cleanPath(bad), null, bad); assert.equal(cleanPath('./src\\app.js'), 'src/app.js'); assert.equal(cleanPath('a//b/'), 'a/b');
});

test('importing files: screening, secrets, limits, permissions, attribution', async () => {
  const owner = await person('Ivy Importer', 'ivy@x.io', 'ivy-i'); const viewer = await person('Vic Viewer', 'vic@x.io', 'vic-v'); const out = await person('Out Sider', 'outs@x.io', 'out-s');
  const ws = (await owner.call('POST', '/api/projects', { name: 'Import Room' })).body.id; const inv = await owner.call('POST', `/api/projects/${ws}/invite-user`, { username: 'vic-v', role: 'viewer' }); await viewer.call('POST', `/api/invitations/${inv.body.id}/accept`, {});
  const files = [f('src/app.py', 'print("hello")\n'.repeat(20)), f('src/util.js', 'export const a = 1;\r\nexport const b = 2;\r\n'), f('index.html', '<h1>Hi</h1>\n'), f('README.md', '# Imported\n\nHello **world**\n'), f('.env', 'SECRET=1'), f('node_modules/x/index.js', 'x'), f('image.png', 'binary'), f('data.bin', 'a\0b'), f('../escape.txt', 'no'), f('/abs.txt', 'no'), f('src/app.py', 'duplicate'), f('big.txt', 'x'.repeat(600_000)), f('keys.js', 'const k = "AKIAABCDEFGHIJKLMNOP";'), { path: 'nocontent.txt' }];
  const r = await owner.call('POST', `/api/projects/${ws}/import`, { files }); assert.equal(r.status, 200); assert.equal(r.body.imported, 4, 'README.md already exists in a new project, so it is skipped');
  const reasons = Object.fromEntries(r.body.skipped.map((s) => [s.path, s.reason])); assert.match(reasons['README.md'], /already exists/); assert.match(reasons['.env'], /secrets/); assert.match(reasons['node_modules/x/index.js'], /ignored/); assert.match(reasons['image.png'], /ignored/); assert.match(reasons['data.bin'], /binary/); assert.match(reasons['../escape.txt'], /unsafe/); assert.match(reasons['/abs.txt'], /unsafe/); assert.match(reasons['big.txt'], /larger/); assert.match(reasons['nocontent.txt'], /not a text file/); assert.ok(r.body.skipped.some((s) => /duplicate/.test(s.reason)));
  assert.equal(r.body.warnings.length, 1); assert.match(r.body.warnings[0].issue, /AWS access key/);
  const proj = app.db.projects.find((p) => p.id === ws); assert.equal(proj.files['src/util.js'], 'export const a = 1;\nexport const b = 2;\n', 'CRLF normalised'); assert.equal(proj.files['.env'], undefined);
  // re-import: existing files are kept unless overwrite is requested
  const again = await owner.call('POST', `/api/projects/${ws}/import`, { files: [f('index.html', '<h1>New</h1>\n')] }); assert.equal(again.body.imported, 0); assert.match(again.body.skipped[0].reason, /already exists/);
  assert.equal((await owner.call('POST', `/api/projects/${ws}/import`, { files: [f('index.html', '<h1>New</h1>\n')], overwrite: true })).body.imported, 1); assert.equal(proj.files['index.html'], '<h1>New</h1>\n');
  // permissions and validation
  assert.equal((await viewer.call('POST', `/api/projects/${ws}/import`, { files })).status, 403); assert.equal((await out.call('POST', `/api/projects/${ws}/import`, { files })).status, 404); assert.equal((await owner.call('POST', `/api/projects/${ws}/import`, { files: [] })).status, 400); assert.equal((await owner.call('POST', `/api/projects/${ws}/import`, { files: Array.from({ length: 301 }, (_, i) => f(`f${i}.js`, 'x')) })).status, 413);
  // history is attributed to the importer and marked as an import (never a "paste")
  const h = app.db.history[ws].filter((e) => e.kind === 'import'); assert.ok(h.length >= 4); assert.ok(h.every((e) => e.uid === owner.id && /Ivy Importer \(import\)/.test(e.actor)));
  // large uploads (several MB) get through in one request
  const big = Array.from({ length: 12 }, (_, i) => f(`bulk/f${i}.js`, `// ${i}\n` + 'const x = 1;\n'.repeat(30000))); const bulk = await owner.call('POST', `/api/projects/${ws}/import`, { files: big }); assert.equal(bulk.status, 200); assert.equal(bulk.body.imported, 12);
});

test('overview: README, languages, totals, contributors with avatars data, activity', async () => {
  const a = await person('Ann Author', 'ann@x.io', 'ann-a'); const b = await person('Bo Builder', 'bo@x.io', 'bo-b'); const ws = (await a.call('POST', '/api/projects', { name: 'Overview Room', description: 'Shows stats' })).body.id;
  const inv = await a.call('POST', `/api/projects/${ws}/invite-user`, { username: 'bo-b', role: 'editor' }); await b.call('POST', `/api/invitations/${inv.body.id}/accept`, {});
  await a.call('POST', `/api/projects/${ws}/import`, { files: [f('app.py', 'print(1)\n'.repeat(100)), f('web/index.html', '<p>x</p>\n'.repeat(20)), f('README.md', '# Overview Room\n\nSome docs\n')], overwrite: true });
  for (let i = 0; i < 4; i++) await b.call('PUT', `/api/projects/${ws}/files`, { path: 'web/app.js', content: `console.log(${i});\n`.repeat(i + 1) });
  const o = (await a.call('GET', `/api/projects/${ws}/overview`)).body;
  assert.equal(o.readme.path, 'README.md'); assert.match(o.readme.content, /Some docs/); assert.equal(o.project.name, 'Overview Room'); assert.equal(o.project.role, 'owner');
  assert.deepEqual(o.languages.map((l) => l.language), ['Python', 'HTML', 'JavaScript'], 'largest first, by bytes'); assert.ok(Math.abs(o.languages.reduce((n, l) => n + l.percent, 0) - 100) < 0.5); assert.ok(o.languages[0].color.startsWith('#'));
  assert.ok(o.totals.files >= 4 && o.totals.lines > 100 && o.totals.bytes > 0);
  const names = o.contributors.map((c) => c.username); assert.ok(names.includes('ann-a') && names.includes('bo-b')); const bo = o.contributors.find((c) => c.username === 'bo-b'); assert.equal(bo.edits, 4, 'one recorded edit per save'); assert.ok(bo.edits >= 1 && bo.additions > 0 && bo.initials === 'BB' && bo.role === 'editor');
  assert.ok(Math.abs(o.contributors.reduce((n, c) => n + c.share, 0) - 100) < 0.6); assert.ok(o.members.every((m) => m.username)); assert.ok(o.updatedAt >= o.project.createdAt); assert.ok(o.activity.some((x) => /imported/.test(x.action)));
  // a member who has not edited still appears; agents are grouped separately
  const c = await person('Cam Quiet', 'cam@x.io', 'cam-q'); const inv2 = await a.call('POST', `/api/projects/${ws}/invite-user`, { username: 'cam-q', role: 'viewer' }); await c.call('POST', `/api/invitations/${inv2.body.id}/accept`, {});
  app.db.history[ws].push({ id: 'ag1', path: 'x.py', actor: 'Claude Code (MCP, for Ann Author)', kind: 'agent_edit', createdAt: Date.now(), size: 5, added: 5, content: 'x = 1' });
  const o2 = (await a.call('GET', `/api/projects/${ws}/overview`)).body; assert.ok(o2.contributors.some((x) => x.username === 'cam-q' && x.edits === 0)); const agent = o2.contributors.find((x) => x.agent); assert.equal(agent.name, 'AI agents'); assert.equal(agent.edits, 1);
  assert.equal((await c.call('GET', `/api/projects/${ws}/overview`)).status, 200); assert.equal((await (await person('Nope N', 'nope@x.io', 'nope-n')).call('GET', `/api/projects/${ws}/overview`)).status, 404);
  // tree + single file
  const tree = (await a.call('GET', `/api/projects/${ws}/tree`)).body.files; assert.ok(tree.some((x) => x.path === 'app.py' && x.language === 'Python' && x.size > 0)); const file = await a.call('GET', `/api/projects/${ws}/file?path=${encodeURIComponent('web/index.html')}`); assert.match(file.body.content, /<p>x<\/p>/); assert.equal((await a.call('GET', `/api/projects/${ws}/file?path=${encodeURIComponent('../x')}`)).status, 404);
});

test('rename, delete, new folder, and ZIP export', async () => {
  const o = await person('File Ops', 'ops@x.io', 'file-ops'); const v = await person('Vi V', 'viv@x.io', 'vi-v'); const ws = (await o.call('POST', '/api/projects', { name: 'Ops Room' })).body.id; const proj = () => app.db.projects.find((p) => p.id === ws);
  await o.call('POST', `/api/projects/${ws}/import`, { files: [f('src/a.js', 'a'), f('src/b.js', 'b'), f('docs/x.md', 'x'), f('top.txt', 't')], overwrite: true });
  assert.equal((await o.call('POST', `/api/projects/${ws}/files/rename`, { from: 'top.txt', to: 'renamed.txt' })).body.moved, 1); assert.equal(proj().files['renamed.txt'], 't'); assert.equal(proj().files['top.txt'], undefined);
  assert.equal((await o.call('POST', `/api/projects/${ws}/files/rename`, { from: 'src', to: 'lib' })).body.moved, 2); assert.deepEqual(Object.keys(proj().files).filter((x) => x.startsWith('lib/')).sort(), ['lib/a.js', 'lib/b.js']);
  assert.equal((await o.call('POST', `/api/projects/${ws}/files/rename`, { from: 'lib/a.js', to: 'lib/b.js' })).status, 409); assert.equal((await o.call('POST', `/api/projects/${ws}/files/rename`, { from: 'lib', to: 'lib/inner' })).status, 400); assert.equal((await o.call('POST', `/api/projects/${ws}/files/rename`, { from: 'ghost', to: 'x' })).status, 404); assert.equal((await o.call('POST', `/api/projects/${ws}/files/rename`, { from: 'lib/a.js', to: '../out.js' })).status, 400);
  assert.equal((await o.call('POST', `/api/projects/${ws}/files/mkdir`, { path: 'assets/img' })).status, 201); assert.ok(proj().files['assets/img/.gitkeep'] !== undefined);
  assert.equal((await o.call('DELETE', `/api/projects/${ws}/files?path=renamed.txt`)).body.deleted, 1); assert.equal((await o.call('DELETE', `/api/projects/${ws}/files?path=lib`)).status, 404, 'a folder needs folder=1'); assert.equal((await o.call('DELETE', `/api/projects/${ws}/files?path=lib&folder=1`)).body.deleted, 2);
  assert.equal((await v.call('DELETE', `/api/projects/${ws}/files?path=docs/x.md`)).status, 404, 'outsiders see nothing');
  const hist = app.db.history[ws]; assert.ok(hist.some((e) => e.deleted && e.path === 'lib/a.js')); const { stateAt } = await import('../lib/judging.mjs'); const final = stateAt(hist, hist.length - 1); assert.equal(final['lib/a.js'], undefined, 'replay knows the file was deleted'); assert.equal(final['docs/x.md'], 'x');
  const zip = await o.call('GET', `/api/projects/${ws}/export.zip`, undefined, true); assert.equal(zip.status, 200); assert.equal(zip.headers.get('content-type'), 'application/zip'); assert.match(zip.headers.get('content-disposition'), /ops-room\.zip/); const entries = unzipSync(new Uint8Array(await zip.arrayBuffer())); assert.equal(strFromU8(entries['docs/x.md']), 'x'); assert.ok(!('lib/a.js' in entries));
  // frozen workspaces reject every write operation
  proj().frozen = true; for (const [m, p, b] of [['POST', 'files/rename', { from: 'docs/x.md', to: 'docs/y.md' }], ['POST', 'files/mkdir', { path: 'new' }], ['POST', 'import', { files: [f('z.js', 'z')] }]]) assert.equal((await o.call(m, `/api/projects/${ws}/${p}`, b)).status, 403, p); assert.equal((await o.call('DELETE', `/api/projects/${ws}/files?path=docs/x.md`)).status, 403); proj().frozen = false;
});

test('import from GitHub: filters files, handles private/limited repos, uses the default branch', async () => {
  const o = await person('Gh Importer', 'ghi@x.io', 'gh-importer'); const ws = (await o.call('POST', '/api/projects', { name: 'Gh Room' })).body.id; const proj = () => app.db.projects.find((p) => p.id === ws);
  assert.equal((await o.call('POST', `/api/projects/${ws}/import-github`, { owner: 'bad owner!', repo: 'x' })).status, 400);
  const r = await o.call('POST', `/api/projects/${ws}/import-github`, { owner: 'octo', repo: 'hello', overwrite: true }); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.branch, 'trunk'); assert.equal(r.body.repo, 'octo/hello'); assert.equal(r.body.imported, 2);
  assert.equal(proj().files['src/main.py'], 'print("hi from github")\n'); assert.match(proj().files['README.md'], /From GitHub/); assert.equal(proj().files['.env'], undefined); assert.equal(proj().files['logo.png'], undefined);
  assert.ok(!ghCalls.some((u) => /e1|n1|l1|b1/.test(u) && u.includes('/blobs/')), 'filtered files are never downloaded');
  const priv = await o.call('POST', `/api/projects/${ws}/import-github`, { owner: 'octo', repo: 'private' }); assert.equal(priv.status, 404); assert.match(priv.body.error, /Connect GitHub/);
  const lim = await o.call('POST', `/api/projects/${ws}/import-github`, { owner: 'octo', repo: 'limited' }); assert.equal(lim.status, 429); assert.match(lim.body.error, /rate limiting/);
  assert.equal(app.db.history[ws].filter((e) => e.kind === 'import').length >= 2, true);
  for (let i = 0; i < 5; i++) await o.call('POST', `/api/projects/${ws}/import-github`, { owner: 'octo', repo: 'private' }); assert.equal((await o.call('POST', `/api/projects/${ws}/import-github`, { owner: 'octo', repo: 'private' })).status, 429, 'rate limited');
});

test('downloads: Local Bridge zip and VS Code extension are well-formed', async () => {
  const vm = await import('node:vm');
  const zip = await fetch(`${base}/download/hackconnect-bridge.zip`); assert.equal(zip.status, 200); assert.equal(zip.headers.get('content-type'), 'application/zip');
  const z = unzipSync(new Uint8Array(await zip.arrayBuffer())); assert.deepEqual(Object.keys(z).sort(), ['README.md', 'bridge/agent-bridge.mjs', 'bridge/cli.mjs', 'bridge/sync.mjs', 'bridge/tunnel.mjs', 'lib/secrets.mjs', 'package.json']);
  const pkg = JSON.parse(strFromU8(z['package.json'])); assert.equal(pkg.bin.hackconnect, 'bridge/cli.mjs'); assert.ok(pkg.dependencies.ws && pkg.dependencies.yjs && pkg.dependencies['y-protocols'] && pkg.dependencies.lib0); assert.match(strFromU8(z['README.md']), /hackconnect login --server http:\/\/127\.0\.0\.1:\d+/);
  assert.ok(strFromU8(z['bridge/sync.mjs']).includes("from '../lib/secrets.mjs'"), 'relative import still resolves inside the package');
  const ext = await fetch(`${base}/download/hackconnect-vscode.vsix`); assert.equal(ext.status, 200); const x = unzipSync(new Uint8Array(await ext.arrayBuffer()));
  for (const required of ['[Content_Types].xml', 'extension.vsixmanifest', 'extension/package.json', 'extension/extension.js']) assert.ok(x[required], `${required} present`);
  const manifest = JSON.parse(strFromU8(x['extension/package.json'])); assert.equal(manifest.main, './extension.js'); assert.equal(manifest.publisher, 'hackconnect'); assert.ok(manifest.contributes.commands.length >= 4); assert.match(manifest.contributes.configuration.properties['hackconnect.serverUrl'].default, /^http:\/\/127\.0\.0\.1:\d+$/);
  for (const c of manifest.contributes.commands) assert.ok(strFromU8(x['extension/extension.js']).includes(`'${c.command}'`), `${c.command} is registered`);
  new vm.Script(strFromU8(x['extension/extension.js'])); // syntactically valid JavaScript
  assert.match(strFromU8(x['extension.vsixmanifest']), /<Identity Language="en-US" Id="hackconnect" Version="0.1.0" Publisher="hackconnect"/);
});

test('rename/describe a project and delete it (owner only, confirmation required, events protected)', async () => {
  const o = await person('Mgr M', 'mgr@x.io', 'mgr-m'); const e = await person('Ed E', 'ede@x.io', 'ed-e'); const ws = (await o.call('POST', '/api/projects', { name: 'Old Name' })).body.id;
  const inv = await o.call('POST', `/api/projects/${ws}/invite-user`, { username: 'ed-e', role: 'editor' }); await e.call('POST', `/api/invitations/${inv.body.id}/accept`, {});
  assert.equal((await e.call('PATCH', `/api/projects/${ws}`, { name: 'Hijack' })).status, 403); assert.equal((await o.call('PATCH', `/api/projects/${ws}`, { name: '' })).status, 400); assert.equal((await o.call('PATCH', `/api/projects/${ws}`, { name: 'x'.repeat(81) })).status, 400);
  const r = await o.call('PATCH', `/api/projects/${ws}`, { name: 'New Name', description: 'Fresh description' }); assert.equal(r.status, 200); assert.equal((await o.call('GET', `/api/projects/${ws}`)).body.project.name, 'New Name');
  assert.equal((await e.call('DELETE', `/api/projects/${ws}`, { confirmName: 'New Name' })).status, 403); assert.equal((await o.call('DELETE', `/api/projects/${ws}`, { confirmName: 'wrong' })).status, 400); assert.ok(app.db.projects.some((p) => p.id === ws));
  assert.equal((await o.call('DELETE', `/api/projects/${ws}`, { confirmName: 'New Name' })).status, 200); assert.ok(!app.db.projects.some((p) => p.id === ws)); assert.equal(app.db.history[ws], undefined); assert.equal((await e.call('GET', `/api/projects/${ws}`)).status, 404);
  const org = await person('Org O2', 'org2@x.io', 'org-o2'); const dev = await person('Dev D2', 'dev2@x.io', 'dev-d2'); const ev = (await org.call('POST', '/api/events', { title: 'Keep Me' })).body; await org.call('PATCH', `/api/events/${ev.id}`, { status: 'registration' }); await dev.call('POST', `/api/events/${ev.id}/register`, {}); const team = (await dev.call('POST', `/api/events/${ev.id}/teams`, { name: 'Protected' })).body;
  const del = await dev.call('DELETE', `/api/projects/${team.workspaceId}`, { confirmName: app.db.projects.find((p) => p.id === team.workspaceId).name }); assert.equal(del.status, 409);
});
