// Tokens, device login, approval gate, tunnels, call tokens, sandbox runs, MCP, admin, account export/delete.
import crypto from 'node:crypto';
import { can, workspaceRole } from './policy.mjs';
import { sha256, newToken, verifyPassword } from './auth.mjs';
import { scanSecrets, isSensitivePath } from './secrets.mjs';
import { encrypt, decrypt } from './crypto.mjs';
import { PRESETS, assertSafeAiUrl } from './agent.mjs';

export const PLANS = { free: { workspaces: 10, tokens: 20, runsPerDay: 50 }, pro: { workspaces: 100, tokens: 200, runsPerDay: 1000 } };
const SAFE_PATH = (v) => { const s = String(v || '').replaceAll('\\', '/'); return s && !s.startsWith('/') && !/^[a-zA-Z]:/.test(s) && !s.split('/').includes('..') && s !== '.' ? s : null; };

/** Small LCS line diff for approval previews. Falls back to full replace for very large files. */
export function lineDiff(a, b) {
  const x = a.split('\n'); const y = b.split('\n');
  if (x.length * y.length > 4_000_000) return [...x.map((t) => ({ t: '-', s: t })), ...y.map((t) => ({ t: '+', s: t }))];
  const dp = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0; let j = 0;
  while (i < x.length && j < y.length) { if (x[i] === y[j]) { out.push({ t: ' ', s: x[i] }); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: '-', s: x[i++] }); else out.push({ t: '+', s: y[j++] }); }
  while (i < x.length) out.push({ t: '-', s: x[i++] }); while (j < y.length) out.push({ t: '+', s: y[j++] });
  return out;
}

const b64u = (b) => Buffer.from(b).toString('base64url');
export function livekitToken({ key, secret, room, identity, name, canPublish }) {
  const now = Math.floor(Date.now() / 1000); const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: key, sub: identity, name, nbf: now, exp: now + 3600, video: { room, roomJoin: true, canPublish, canSubscribe: true, canPublishData: canPublish } }));
  return `${head}.${body}.${crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}

export function createPlatform({ db, json, fail, audit, activity, collab, save, notify, project, runner, limiter, broadcast = () => {}, signingKey = crypto.randomBytes(32), allowInsecureTunnels = false }) {
  db.tokens ||= []; db.devices ||= []; db.proposals ||= []; db.tunnels ||= []; db.reports ||= []; db.settings ||= { killSwitch: false, flags: {} };
  const settings = db.settings;
  const proj = (user, id, action) => { const p = project(id); if (!p || workspaceRole(p, user) === null) throw fail(404, 'Project not found'); if (!can(user, action, p)) throw fail(403, 'You do not have permission to do that'); return p; };
  // ---- per-user AI assistant settings (key encrypted with the master key; never returned by the API)
  const allowPrivateAi = () => process.env.HACKCONNECT_ALLOW_PRIVATE_AI ? process.env.HACKCONNECT_ALLOW_PRIVATE_AI === 'true' : !/^https:\/\//i.test(process.env.HACKCONNECT_BASE_URL || '');
  const aiView = (user) => { const a = user.ai || {}; return { provider: a.provider || '', model: a.model || '', baseUrl: a.baseUrl || '', hasKey: Boolean(a.keyEnc), presets: PRESETS, serverDefault: process.env.HACKCONNECT_AGENT_PROVIDER || 'demo', allowPrivate: allowPrivateAi() }; };
  const aiConfigFor = (user) => { const a = user.ai; if (!a?.provider) return null; let apiKey = ''; try { apiKey = a.keyEnc ? decrypt(signingKey, a.keyEnc) : ''; } catch { apiKey = ''; } return { provider: a.provider, model: a.model, baseUrl: a.baseUrl, apiKey }; };
  const eventPolicyBlocks = (p) => { const e = p.eventId && db.events?.find((x) => x.id === p.eventId); return Boolean(e && e.agentPolicy === 'none'); };

  // ---- authenticated preview proxy for tunnels: /t/<tunnelId>/<userId>.<exp>.<sig>/<path>
  // The raw tunnel URL is never handed to teammates. Links are signed, expire after an hour, are re-checked against the
  // tunnel's visibility on every request, and responses are sandboxed (opaque origin: no cookies, no access to this site).
  const sign = (tunnelId, userId, exp) => crypto.createHmac('sha256', signingKey).update(`${tunnelId}|${userId}|${exp}`).digest('base64url');
  const tunnelToken = (t, userId, ttlMs = 3600 * 1000) => { const exp = Date.now() + ttlMs; return `${userId}.${exp}.${sign(t.id, userId, exp)}`; };
  function tunnelAllowed(t, user) {
    const p = project(t.workspaceId); if (!p || !user || user.suspended) return false; const role = workspaceRole(p, user);
    if (t.visibility === 'public') return true;
    if (t.visibility === 'judges') { const e = p.eventId && db.events?.find((x) => x.id === p.eventId); return role !== null || Boolean(e && e.members?.[user.id] === 'judge'); }
    if (role === null) return false; return t.visibility === 'team' || t.userId === user.id || role === 'owner';
  }
  const PASS_REQUEST = ['accept', 'accept-language', 'range', 'if-none-match', 'if-modified-since'];
  const PASS_RESPONSE = ['content-type', 'cache-control', 'etag', 'last-modified', 'content-range', 'accept-ranges', 'content-language'];
  async function handleTunnel(req, res, url) {
    const deny = (status, message) => json(res, status, { error: message });
    if (!['GET', 'HEAD'].includes(req.method)) return deny(405, 'Previews are read-only (GET/HEAD)');
    const [, , id, token, ...rest] = url.pathname.split('/'); const [userId, expRaw, sig] = String(token || '').split('.'); const exp = Number(expRaw);
    const t = db.tunnels.find((x) => x.id === id && !x.closed); if (!t) return deny(404, 'This shared app is no longer available');
    const expected = userId && exp ? sign(t.id, userId, exp) : ''; const ok = sig && expected.length === sig.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
    if (!ok || exp < Date.now()) return deny(403, 'This preview link is invalid or has expired. Open the workspace and click the link again.');
    if (settings.killSwitch) return deny(503, 'Tunnels are disabled by an administrator');
    if (!tunnelAllowed(t, db.users.find((u) => u.id === userId))) return deny(403, 'You no longer have access to this shared app');
    const target = new URL(`/${rest.map((s) => s).join('/')}${url.search}`, t.url); if (target.origin !== new URL(t.url).origin) return deny(400, 'Bad path');
    const headers = { 'user-agent': 'HackConnect-Preview' }; for (const name of PASS_REQUEST) if (req.headers[name]) headers[name] = req.headers[name];
    let upstream; try { upstream = await fetch(target, { method: req.method, headers, redirect: 'manual', signal: AbortSignal.timeout(15000) }); } catch { return deny(502, 'The shared app did not respond. Is it still running on its owner\'s computer?'); }
    const out = { 'content-security-policy': 'sandbox allow-scripts allow-forms allow-popups allow-modals', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store' };
    for (const name of PASS_RESPONSE) { const value = upstream.headers.get(name); if (value && name !== 'cache-control') out[name] = value; }
    const location = upstream.headers.get('location'); if (location) { try { const next = new URL(location, target); if (next.origin === target.origin) out.location = `/t/${id}/${token}${next.pathname}${next.search}`; } catch { /* drop bad redirects */ } }
    const body = Buffer.from(await upstream.arrayBuffer()); if (body.length > 20 * 1024 * 1024) return deny(502, 'Response too large for the preview');
    res.writeHead(upstream.status, { ...out, 'content-length': body.length }); res.end(req.method === 'HEAD' ? undefined : body);
  }

  // ---- device-code login for the Local Bridge
  function deviceStart() {
    db.devices = db.devices.filter((d) => d.expiresAt > Date.now() - 60000);
    const code = crypto.randomBytes(5).toString('hex').toUpperCase(); const userCode = `${code.slice(0, 4)}-${code.slice(4, 8)}`; const deviceCode = newToken(24);
    db.devices.push({ hash: sha256(deviceCode), userCode, expiresAt: Date.now() + 10 * 60000, userId: null, label: 'Local Bridge' }); save(); return { deviceCode, userCode, interval: 2, expiresIn: 600 };
  }
  function deviceToken(deviceCode) {
    const d = db.devices.find((x) => x.hash === sha256(String(deviceCode || ''))); if (!d || d.expiresAt < Date.now()) return { status: 410, body: { error: 'Code expired. Run login again.' } };
    if (!d.userId) return { status: 202, body: { status: 'pending' } };
    db.devices = db.devices.filter((x) => x !== d); const token = `hc_${newToken(32)}`;
    db.tokens.push({ id: crypto.randomUUID(), hash: sha256(token), kind: 'bridge', userId: d.userId, label: d.label, createdAt: Date.now(), expiresAt: Date.now() + 30 * 24 * 3600 * 1000 }); audit({ id: d.userId }, 'token.bridge.issue', d.userId); save(); return { status: 200, body: { token } };
  }
  const addExtras = async ({ req, res, user, parts, body }) => {
    const sub = parts[3];
    if (parts[1] === 'device' && parts[2] === 'approve' && req.method === 'POST') {
      if (req.token) throw fail(403, 'Approve from the web app, not from a token');
      const d = db.devices.find((x) => x.userCode === String(body.userCode || '').trim().toUpperCase() && x.expiresAt > Date.now()); if (!d) return json(res, 404, { error: 'That code is invalid or expired' }), true;
      d.userId = user.id; save(); return json(res, 200, { ok: true }), true;
    }
    // ---- scoped tokens (MCP + bridge management)
    if (parts[1] === 'projects' && sub === 'tokens') {
      const p = proj(user, parts[2], 'workspace.manage');
      if (req.method === 'GET') return json(res, 200, { tokens: db.tokens.filter((t) => t.workspaceId === p.id && !t.revoked).map((t) => ({ id: t.id, kind: t.kind, role: t.role, label: t.label, createdAt: t.createdAt, expiresAt: t.expiresAt })) }), true;
      if (req.method === 'POST') {
        const plan = PLANS[user.plan || 'free']; if (db.tokens.filter((t) => t.userId === user.id && !t.revoked).length >= plan.tokens) return json(res, 402, { error: 'Token limit reached for your plan' }), true;
        const role = body.role === 'viewer' ? 'viewer' : 'editor'; const token = `hc_${newToken(32)}`;
        const rec = { id: crypto.randomUUID(), hash: sha256(token), kind: 'mcp', userId: user.id, workspaceId: p.id, role, label: String(body.label || 'External agent').slice(0, 60), createdAt: Date.now(), expiresAt: Date.now() + 30 * 24 * 3600 * 1000 };
        db.tokens.push(rec); audit(user, 'token.mcp.create', p.id, role); save(); return json(res, 201, { id: rec.id, token, role, mcpUrl: '/mcp', expiresAt: rec.expiresAt }), true;
      }
      if (req.method === 'DELETE' && parts[4]) { const t = db.tokens.find((x) => x.id === parts[4] && x.workspaceId === p.id); if (!t) return json(res, 404, { error: 'Token not found' }), true; t.revoked = true; audit(user, 'token.revoke', p.id, t.id); save(); return json(res, 200, { ok: true }), true; }
    }
    // ---- workspace settings (agent approval gate)
    if (parts[1] === 'projects' && parts.length === 3 && req.method === 'PATCH') {
      const p = proj(user, parts[2], 'workspace.manage'); if (body.agentApproval !== undefined) { if (!['ask', 'auto'].includes(body.agentApproval)) return json(res, 400, { error: 'agentApproval must be ask or auto' }), true; p.agentApproval = body.agentApproval; }
      if (body.name !== undefined) { const name = String(body.name).trim(); if (!name || name.length > 80) return json(res, 400, { error: 'Project name must be 1-80 characters' }), true; p.name = name; }
      if (body.description !== undefined) p.description = String(body.description).slice(0, 300);
      audit(user, 'workspace.settings', p.id, JSON.stringify({ agentApproval: p.agentApproval, name: p.name })); save(); return json(res, 200, { agentApproval: p.agentApproval || 'ask', name: p.name, description: p.description }), true;
    }
    if (parts[1] === 'projects' && parts.length === 3 && req.method === 'DELETE') {
      const p = proj(user, parts[2], 'workspace.manage'); if (p.eventId) return json(res, 409, { error: 'Hackathon workspaces cannot be deleted by their team. Ask the organizer.' }), true;
      if (String(body.confirmName || '') !== p.name) return json(res, 400, { error: 'Type the project name exactly to confirm' }), true;
      for (const uid of Object.keys(p.members)) collab.kick(p.id, uid);
      db.projects = db.projects.filter((x) => x.id !== p.id); delete db.messages[p.id]; delete db.history[p.id]; if (db.yjs) delete db.yjs[p.id]; collab.drop(p.id);
      db.tokens = db.tokens.filter((t) => t.workspaceId !== p.id); db.proposals = db.proposals.filter((x) => x.projectId !== p.id); db.tunnels = db.tunnels.filter((t) => t.workspaceId !== p.id); db.invitations = (db.invitations || []).filter((i) => !(i.kind === 'workspace' && i.targetId === p.id));
      audit(user, 'workspace.delete', p.id, p.name); save(); return json(res, 200, { ok: true }), true;
    }
    // ---- proposals
    if (parts[1] === 'projects' && sub === 'proposals') {
      const p = proj(user, parts[2], 'workspace.read');
      if (req.method === 'GET') return json(res, 200, { proposals: db.proposals.filter((x) => x.projectId === p.id && x.status === 'pending').map((x) => ({ id: x.id, path: x.path, actor: x.actor, createdAt: x.createdAt, diff: lineDiff(x.oldContent, x.newContent) })) }), true;
      if (req.method === 'POST' && parts[4] && ['approve', 'reject'].includes(parts[5])) {
        proj(user, p.id, 'workspace.write'); const x = db.proposals.find((q) => q.id === parts[4] && q.projectId === p.id && q.status === 'pending'); if (!x) return json(res, 404, { error: 'Proposal not found' }), true;
        if (parts[5] === 'reject') { x.status = 'rejected'; save(); broadcast(p.id, { type: 'proposals.changed' }); return json(res, 200, { status: 'rejected' }), true; }
        if ((p.files[x.path] ?? '') !== x.oldContent) return json(res, 409, { error: 'The file changed after this proposal was made. Ask the agent to try again.' }), true;
        collab.writeFile(p, x.path, x.newContent, x.actor, 'agent_edit', x.onBehalfOf); x.status = 'approved'; x.decidedBy = user.id; broadcast(p.id, { type: 'proposals.changed' }); audit(user, 'proposal.approve', p.id, x.path);
        activity({ name: x.actor, initials: 'AI' }, 'edited', `${p.name}/${x.path}`, `Approved by ${user.name}`, p.id); save(); return json(res, 200, { status: 'approved', path: x.path }), true;
      }
    }
    // ---- tunnels registered by the Local Bridge (URLs are only ever shown to workspace members)
    if (parts[1] === 'projects' && sub === 'tunnels') {
      const p = proj(user, parts[2], req.method === 'GET' ? 'workspace.read' : 'workspace.write');
      if (req.method === 'GET') return json(res, 200, { tunnels: db.tunnels.filter((t) => t.workspaceId === p.id && !t.closed && tunnelAllowed(t, user)).map((t) => ({ id: t.id, port: t.port, visibility: t.visibility, by: t.by, previewUrl: `/t/${t.id}/${tunnelToken(t, user.id)}/`, ...(t.userId === user.id ? { url: t.url } : {}) })) }), true;
      if (req.method === 'POST') {
        if (settings.killSwitch) return json(res, 503, { error: 'Tunnels are disabled by an administrator' }), true;
        let u; try { u = new URL(String(body.url)); } catch { return json(res, 400, { error: 'A valid tunnel URL is required' }), true; } if (u.protocol !== 'https:' && !(allowInsecureTunnels && u.protocol === 'http:')) return json(res, 400, { error: 'Tunnel URL must be https' }), true;
        const port = Number(body.port); if (!(port > 0 && port < 65536)) return json(res, 400, { error: 'Invalid port' }), true;
        const t = { id: crypto.randomUUID(), workspaceId: p.id, port, url: u.origin, visibility: 'private', by: user.name, userId: user.id, at: Date.now() }; db.tunnels.push(t); audit(user, 'tunnel.open', p.id, String(port)); save(); return json(res, 201, t), true;
      }
      if (req.method === 'PATCH' && parts[4]) { const t = db.tunnels.find((x) => x.id === parts[4] && x.workspaceId === p.id); if (!t) return json(res, 404, { error: 'Tunnel not found' }), true; if (!['private', 'team', 'judges', 'public'].includes(body.visibility)) return json(res, 400, { error: 'Invalid visibility' }), true; t.visibility = body.visibility; save(); return json(res, 200, t), true; }
      if (req.method === 'DELETE' && parts[4]) { const t = db.tunnels.find((x) => x.id === parts[4] && x.workspaceId === p.id); if (t) t.closed = true; save(); return json(res, 200, { ok: true }), true; }
    }
    // ---- LiveKit token (falls back to browser P2P when LiveKit is not configured)
    if (parts[1] === 'projects' && sub === 'call-token' && req.method === 'POST') {
      const p = proj(user, parts[2], 'workspace.chat'); const { LIVEKIT_URL: url, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret } = process.env;
      if (!url || !key || !secret) return json(res, 503, { error: 'LiveKit is not configured', fallback: 'p2p' }), true;
      return json(res, 200, { url, token: livekitToken({ key, secret, room: `ws-${p.id}`, identity: user.id, name: user.name, canPublish: can(user, 'workspace.write', p) || workspaceRole(p, user) !== 'viewer' }) }), true;
    }
    // ---- sandbox run
    if (parts[1] === 'projects' && sub === 'run' && req.method === 'POST') {
      const p = proj(user, parts[2], 'workspace.write'); if (settings.killSwitch) return json(res, 503, { error: 'Runs are disabled by an administrator' }), true;
      if (!runner) return json(res, 503, { error: 'Sandbox runner is not configured. Install Docker and set HACKCONNECT_RUNNER=docker.' }), true;
      if (!limiter(`run:${user.id}`)) return json(res, 429, { error: 'Too many runs. Slow down.' }), true;
      const command = String(body.command || '').trim(); if (!command || command.length > 500) return json(res, 400, { error: 'A command (max 500 chars) is required' }), true;
      { const r = await runner.run({ files: p.files, command, timeoutMs: 30000, network: false }); audit(user, 'sandbox.run', p.id, command.slice(0, 80)); save(); return json(res, 200, r), true; }
    }
    // ---- reports, usage, account
    if (parts[1] === 'reports' && req.method === 'POST') { const reason = String(body.reason || '').trim().slice(0, 1000); if (!reason) return json(res, 400, { error: 'Please describe the problem' }), true; db.reports.push({ id: crypto.randomUUID(), by: user.id, targetType: String(body.targetType || '').slice(0, 30), targetId: String(body.targetId || '').slice(0, 80), reason, status: 'open', at: Date.now() }); save(); return json(res, 201, { ok: true }), true; }
    if (parts[1] === 'me' && parts[2] === 'ai') {
      if (req.token) throw fail(403, 'Change AI settings from the web app');
      if (req.method === 'GET') return json(res, 200, aiView(user)), true;
      if (req.method === 'DELETE') { delete user.ai; audit(user, 'ai.settings.clear', user.id); save(); return json(res, 200, aiView(user)), true; }
      if (req.method === 'PUT') {
        const provider = String(body.provider || ''); if (provider !== '' && !PRESETS.some((p) => p.id === provider)) return json(res, 400, { error: 'Unknown AI provider' }), true;
        const preset = PRESETS.find((p) => p.id === provider); const next = { provider, model: String(body.model || preset?.model || '').slice(0, 100), baseUrl: String(body.baseUrl ?? preset?.baseUrl ?? '').trim().slice(0, 300), keyEnc: user.ai?.keyEnc || null };
        if (preset?.local) { next.model = ''; next.baseUrl = ''; } // sign-in providers run on the user's own computer: nothing to store
        else if (provider && provider !== 'demo' && provider !== 'anthropic') { try { await assertSafeAiUrl(next.baseUrl || preset?.baseUrl || '', allowPrivateAi()); } catch (error) { return json(res, 400, { error: error.message }), true; } }
        if (typeof body.apiKey === 'string' && body.apiKey.trim()) { const key = body.apiKey.trim(); if (key.length > 500 || /\s/.test(key)) return json(res, 400, { error: 'That does not look like an API key' }), true; next.keyEnc = encrypt(signingKey, key); } else if (body.clearKey === true) next.keyEnc = null;
        if (provider && preset?.needsKey && !next.keyEnc) return json(res, 400, { error: `${preset.label} needs an API key. Paste it in the key field.` }), true;
        user.ai = provider ? next : undefined; if (!provider) delete user.ai; audit(user, 'ai.settings', user.id, provider || 'cleared'); save(); return json(res, 200, aiView(user)), true;
      }
    }
    if (parts[1] === 'me' && parts[2] === 'usage' && req.method === 'GET') { const plan = PLANS[user.plan || 'free']; return json(res, 200, { plan: user.plan || 'free', limits: plan, usage: { workspaces: db.projects.filter((p) => p.members[user.id] === 'owner' && !p.eventId).length, tokens: db.tokens.filter((t) => t.userId === user.id && !t.revoked).length } }), true; }
    if (parts[1] === 'me' && parts[2] === 'export' && req.method === 'GET') {
      const mine = db.projects.filter((p) => p.members[user.id]);
      return json(res, 200, { exportedAt: new Date().toISOString(), profile: { id: user.id, name: user.name, email: user.email, plan: user.plan || 'free', createdAt: user.createdAt }, workspaces: mine.map((p) => ({ id: p.id, name: p.name, role: p.members[user.id], files: p.files })), messages: Object.entries(db.messages).flatMap(([pid, list]) => list.filter((m) => m.userId === user.id).map((m) => ({ workspace: pid, text: m.text, at: m.createdAt }))), audit: db.audit.filter((a) => a.actor === user.id) }), true;
    }
    if (parts[1] === 'me' && parts.length === 2 && req.method === 'DELETE') {
      if (req.token) throw fail(403, 'Delete your account from the web app'); if (!verifyPassword(String(body.password || ''), user.passwordHash)) return json(res, 401, { error: 'Password is incorrect' }), true;
      for (const p of [...db.projects]) { if (!p.members[user.id]) continue; delete p.members[user.id]; if (!Object.values(p.members).includes('owner')) { const next = Object.keys(p.members)[0]; if (next) p.members[next] = 'owner'; else { db.projects = db.projects.filter((x) => x.id !== p.id); delete db.messages[p.id]; delete db.history[p.id]; if (db.yjs) delete db.yjs[p.id]; collab.drop(p.id); } } }
      for (const t of db.teams) delete t.members[user.id]; for (const e of db.events || []) delete e.members[user.id];
      for (const list of Object.values(db.messages)) for (const m of list) if (m.userId === user.id) { m.user = 'Deleted user'; m.initials = '?'; delete m.userId; }
      db.sessions = db.sessions.filter((s) => s.userId !== user.id); db.tokens = db.tokens.filter((t) => t.userId !== user.id); db.notifications = db.notifications.filter((n) => n.userId !== user.id); db.users = db.users.filter((u) => u.id !== user.id);
      audit(null, 'account.delete', user.id); save(); return json(res, 200, { ok: true }, { 'set-cookie': 'hc_session=; Path=/; HttpOnly; Max-Age=0' }), true;
    }
    // ---- admin console
    if (parts[1] === 'admin') {
      if (user.role !== 'admin' || req.token) throw fail(403, 'Administrators only');
      if (parts[2] === 'overview' && req.method === 'GET') return json(res, 200, { users: db.users.length, workspaces: db.projects.length, events: db.events?.length || 0, openReports: db.reports.filter((r) => r.status === 'open').length, killSwitch: settings.killSwitch, flags: settings.flags, activeSessions: db.sessions.filter((s) => s.expiresAt > Date.now()).length }), true;
      if (parts[2] === 'users' && req.method === 'GET') return json(res, 200, { users: db.users.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, plan: u.plan || 'free', suspended: Boolean(u.suspended), createdAt: u.createdAt })) }), true;
      if (parts[2] === 'users' && parts[3] && req.method === 'POST') {
        const u = db.users.find((x) => x.id === parts[3]); if (!u) return json(res, 404, { error: 'User not found' }), true;
        if (body.suspended !== undefined) { if (u.id === user.id) return json(res, 400, { error: 'You cannot suspend yourself' }), true; u.suspended = Boolean(body.suspended); if (u.suspended) db.sessions = db.sessions.filter((s) => s.userId !== u.id); }
        if (body.plan !== undefined) { if (!PLANS[body.plan]) return json(res, 400, { error: 'Unknown plan' }), true; u.plan = body.plan; }
        audit(user, 'admin.user', u.id, JSON.stringify({ suspended: u.suspended, plan: u.plan })); save(); return json(res, 200, { ok: true }), true;
      }
      if (parts[2] === 'flags' && req.method === 'PUT') { const name = String(body.name || '').slice(0, 60); if (!/^[a-z0-9_.-]+$/i.test(name)) return json(res, 400, { error: 'Invalid flag name' }), true; settings.flags[name] = Boolean(body.enabled); audit(user, 'admin.flag', name, String(settings.flags[name])); save(); return json(res, 200, { flags: settings.flags }), true; }
      if (parts[2] === 'kill-switch' && req.method === 'POST') { settings.killSwitch = Boolean(body.enabled); audit(user, 'admin.killswitch', 'platform', String(settings.killSwitch)); save(); return json(res, 200, { killSwitch: settings.killSwitch }), true; }
      if (parts[2] === 'reports' && req.method === 'GET') return json(res, 200, { reports: db.reports }), true;
      if (parts[2] === 'reports' && parts[3] && req.method === 'POST') { const r = db.reports.find((x) => x.id === parts[3]); if (!r) return json(res, 404, { error: 'Report not found' }), true; r.status = 'resolved'; save(); return json(res, 200, r), true; }
      if (parts[2] === 'audit' && req.method === 'GET') return json(res, 200, { audit: db.audit.slice(-200).reverse() }), true;
    }
    return false;
  };

  // ---- MCP over HTTP (JSON-RPC 2.0). Bearer token scoped to one workspace + role.
  const TOOLS = [
    { name: 'list_files', description: 'List all file paths in the shared workspace.', inputSchema: { type: 'object', properties: {} } },
    { name: 'read_file', description: 'Read a file from the workspace.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    { name: 'write_file', description: 'Create or overwrite a file. May be queued for human approval.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
    { name: 'replace_in_file', description: 'Replace one exact occurrence of old_text with new_text in a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } }
  ];
  function applyAgentWrite(p, path, content, actor, user) {
    const old = p.files[path] ?? '';
    if (old === content) return { applied: false, message: 'No change.' };
    const found = scanSecrets(content); const warn = found.length ? ` Warning: content looks like it contains ${found.join(', ')}.` : '';
    if (isSensitivePath(path)) return { applied: false, error: `Refusing to write sensitive file ${path}.` };
    if (content.length > 500_000) return { applied: false, error: 'File too large.' };
    if (p.agentApproval === 'auto') { collab.writeFile(p, path, content, actor, 'agent_edit', user.id); activity({ name: actor, initials: 'AI' }, 'edited', `${p.name}/${path}`, `on behalf of ${user.name}`, p.id); save(); return { applied: true, message: `Wrote ${path}.${warn}` }; }
    const prop = { id: crypto.randomUUID(), projectId: p.id, path, oldContent: old, newContent: content, actor, onBehalfOf: user.id, createdAt: Date.now(), status: 'pending' }; db.proposals.push(prop); activity({ name: actor, initials: 'AI' }, 'proposed a change to', `${p.name}/${path}`, 'Waiting for approval', p.id); save(); broadcast(p.id, { type: 'proposals.changed' });
    return { applied: false, pending: prop.id, message: `Proposed change to ${path}; a human must approve it in HackConnect.${warn}` };
  }
  async function handleMcp(req, res, body, user, token) {
    const reply = (id, result) => json(res, 200, { jsonrpc: '2.0', id, result }); const err = (id, code, message) => json(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
    const p = project(token.workspaceId); if (!p || workspaceRole(p, user) === null) return err(body.id ?? null, -32001, 'Workspace unavailable');
    const { id, method, params } = body;
    if (method === 'initialize') return reply(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'hackconnect', version: '1.0.0' } });
    if (method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') return reply(id, { tools: TOOLS });
    if (method === 'tools/call') {
      const name = params?.name; const a = params?.arguments || {}; const text = (t, isError = false) => reply(id, { content: [{ type: 'text', text: t }], isError });
      if (settings.killSwitch) return text('Agents are disabled by an administrator.', true);
      if (eventPolicyBlocks(p)) return text('This event does not allow agents.', true);
      if (!limiter(`mcp:${token.id}`)) return text('Rate limit exceeded.', true);
      if (name === 'list_files') return text(Object.keys(p.files).sort().join('\n') || '(empty)');
      const path = SAFE_PATH(a.path); if (!path) return text('A safe relative path is required.', true);
      if (name === 'read_file') return p.files[path] === undefined ? text(`No such file: ${path}`, true) : text(p.files[path]);
      const mayWrite = token.role === 'editor' && can(user, 'workspace.write', p); if (!['write_file', 'replace_in_file'].includes(name)) return err(id, -32601, `Unknown tool ${name}`);
      if (!mayWrite) return text(p.frozen ? 'Workspace is frozen.' : 'This token is read-only or you no longer have write access.', true);
      const actor = `${token.label} (MCP, for ${user.name})`;
      if (name === 'write_file') { if (typeof a.content !== 'string') return text('content must be a string.', true); const r = applyAgentWrite(p, path, a.content, actor, user); return text(r.error || r.message, Boolean(r.error)); }
      if (typeof a.old_text !== 'string' || typeof a.new_text !== 'string') return text('old_text and new_text are required.', true);
      const cur = p.files[path]; if (cur === undefined) return text(`No such file: ${path}`, true); const count = cur.split(a.old_text).length - 1; if (count !== 1 || !a.old_text) return text(`old_text must match exactly once (matched ${count}).`, true);
      const r = applyAgentWrite(p, path, cur.replace(a.old_text, () => a.new_text), actor, user); return text(r.error || r.message, Boolean(r.error));
    }
    return err(id, -32601, `Method not found: ${method}`);
  }

  return { aiConfigFor, allowPrivateAi, handleTunnel, handle: addExtras, deviceStart, deviceToken, handleMcp, settings, eventPolicyBlocks, applyAgentWrite };
}
