import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, join, extname, resolve, sep } from 'node:path';
import { normalize } from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { seed } from './seed.mjs';
import { agentRequest, buildLocalPrompt, parseAgent } from './agent.mjs';
import { githubSync } from './github.mjs';
import { createCollab } from './collab.mjs';
import { createEvents } from './events.mjs';
import { createMailer } from './mail.mjs';
import { createSocial, makeUsername, isValidUsername } from './social.mjs';
import { createNexconn } from './nexconn.mjs';
import { createProjects } from './projects.mjs';
import { bridgeZip, vsix, assistantZip } from './downloads.mjs';
import { appendHistory } from './history.mjs';
import { createOAuth } from './oauth.mjs';
import { loadMasterKey, decrypt } from './crypto.mjs';
import { createPlatform, PLANS } from './platform.mjs';
import { createDockerProvider } from './runner.mjs';
import { scanSecrets, isSensitivePath } from './secrets.mjs';
import { createTracker } from './tracker.mjs';
import { colorOfLanguage } from './langs.mjs';
import { can, teamCan, workspaceRole, isWorkspaceRole, isTeamRole } from './policy.mjs';
import { makeIsHttps, hashPassword, verifyPassword, validateSignup, initialsOf, parseCookies, sessionCookie, SESSION_COOKIE, SESSION_TTL_MS, sha256, newToken, createRateLimiter } from './auth.mjs';

// Static assets are an explicit allowlist: never serve server code, .env or state files.
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/events-ui.js': ['events-ui.js', 'text/javascript; charset=utf-8'], '/shell.js': ['shell.js', 'text/javascript; charset=utf-8'], '/app.css': ['app.css', 'text/css; charset=utf-8'], '/projects-ui.js': ['projects-ui.js', 'text/javascript; charset=utf-8'], '/tracker-ui.js': ['tracker-ui.js', 'text/javascript; charset=utf-8'], '/motion.js': ['motion.js', 'text/javascript; charset=utf-8'], '/settings-ui.js': ['settings-ui.js', 'text/javascript; charset=utf-8'], '/call-ui.js': ['call-ui.js', 'text/javascript; charset=utf-8'], '/logos.js': ['logos.js', 'text/javascript; charset=utf-8'], '/config.js': ['config.js', 'text/javascript; charset=utf-8'], '/net.js': ['net.js', 'text/javascript; charset=utf-8'], '/hub-ui.js': ['hub-ui.js', 'text/javascript; charset=utf-8'], '/workspace-ui.js': ['workspace-ui.js', 'text/javascript; charset=utf-8'], '/chat-ui.js': ['chat-ui.js', 'text/javascript; charset=utf-8'], '/vendor/collab-client.js': ['vendor/collab-client.js', 'text/javascript; charset=utf-8'] };
const PUBLIC_FILES = {
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'], '/logo.svg': ['logo.svg', 'image/svg+xml'], '/logo-mark.svg': ['logo-mark.svg', 'image/svg+xml'],
  '/favicon.ico': ['favicon-32.png', 'image/png'], '/favicon-32.png': ['favicon-32.png', 'image/png'], '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
  '/icon-192.png': ['icon-192.png', 'image/png'], '/icon-512.png': ['icon-512.png', 'image/png'], '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json']
};
export { STATIC, PUBLIC_FILES };
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const DUMMY_HASH = hashPassword('hackconnect-dummy-password');

export function createApp({ root, stateFile, secureCookies = false, authLimit = 10, autoBackupMinutes = Number(process.env.HACKCONNECT_AUTOBACKUP_MIN ?? 15), allowInsecureTunnels = false, canonicalLocalhost = false, backupKeep = 48, log = process.env.HACKCONNECT_LOG === 'json', runner = process.env.HACKCONNECT_RUNNER === 'docker' ? createDockerProvider() : null, nexconnOptions = {} } = {}) {
  mkdirSync(dirname(stateFile), { recursive: true });
  const backupDir = join(dirname(stateFile), 'backups');
  // Load state. If the file is unreadable, recover from the newest good backup instead of crashing or overwriting it.
  const loadState = () => {
    if (!existsSync(stateFile)) return seed();
    try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch (error) {
      const candidates = existsSync(backupDir) ? readdirSync(backupDir).filter((f) => /^state-.*\.json$/.test(f)).sort().reverse() : [];
      for (const name of candidates) { try { const recovered = JSON.parse(readFileSync(join(backupDir, name), 'utf8')); renameSync(stateFile, `${stateFile}.corrupt-${Date.now()}`); console.error(`state.json was unreadable (${error.message}); recovered from backup ${name}. The damaged file was kept as *.corrupt-*`); return recovered; } catch { /* try an older backup */ } }
      throw new Error(`State file ${stateFile} is unreadable and no valid backup exists in ${backupDir}. Fix or restore it manually; refusing to start so nothing is overwritten.`);
    }
  };
  const db = loadState();
  db.history ||= {}; db.users ||= []; db.sessions ||= []; db.teams ||= []; db.invites ||= []; db.audit ||= []; db.notifications ||= [];
  for (const item of db.projects) { db.history[item.id] ||= []; item.members ||= {}; }
  for (const u of db.users) if (!u.username) u.username = makeUsername(db, u.name, u.email); // accounts created before usernames existed
  // Projects with no members are leftovers from the pre-auth demo seed: drop them so no fake data is shown to real users.
  for (const item of db.projects.filter((p) => Object.keys(p.members).length === 0)) { delete db.messages[item.id]; delete db.history[item.id]; if (db.yjs) delete db.yjs[item.id]; }
  db.projects = db.projects.filter((item) => Object.keys(item.members).length > 0);

  // Writes are batched: many edits in a burst cost one atomic file write (at most one per 250 ms), flushed on shutdown.
  let saveTimer = null; let dirty = false;
  const saveNow = () => { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } dirty = false; const tmp = `${stateFile}.tmp`; writeFileSync(tmp, JSON.stringify(db)); renameSync(tmp, stateFile); };
  const save = () => { dirty = true; if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; if (dirty) { try { saveNow(); } catch (error) { console.error('saving state failed:', error.message); } } }, 250); };
  if (!existsSync(stateFile)) saveNow();
  const backupNow = () => {
    try {
      saveNow(); mkdirSync(backupDir, { recursive: true }); const name = `state-${new Date().toISOString().replace(/[:.]/g, '-')}.json`; copyFileSync(stateFile, join(backupDir, name));
      const all = readdirSync(backupDir).filter((f) => /^state-.*\.json$/.test(f)).sort(); for (const old of all.slice(0, Math.max(0, all.length - backupKeep))) rmSync(join(backupDir, old)); return name;
    } catch (error) { console.error('backup failed:', error.message); return null; }
  };
  let backupTimer = null; if (autoBackupMinutes > 0) { backupNow(); backupTimer = setInterval(backupNow, autoBackupMinutes * 60000); backupTimer.unref(); }

  const authLimiter = createRateLimiter({ limit: authLimit, windowMs: 15 * 60 * 1000 });
  const writeLimiter = createRateLimiter({ limit: 300, windowMs: 60 * 1000 });

  const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(body)); };
  const readBody = (req, max = 2_000_000) => new Promise((resolve, reject) => { let body = ''; req.on('data', (chunk) => { body += chunk; if (body.length > max) req.destroy(); }); req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(Object.assign(new Error('Request body must be valid JSON'), { status: 400 })); } }); req.on('error', reject); });
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const project = (id) => db.projects.find((item) => item.id === id);
  const team = (id) => db.teams.find((item) => item.id === id);
  const publicUser = (user) => ({ id: user.id, name: user.name, initials: user.initials, email: user.email, role: user.role, username: user.username, bio: user.bio || '', hasPassword: Boolean(user.passwordHash), emailVerified: user.emailVerified !== false, avatar: user.avatar || '' });
  const publicProject = (item, user) => ({ id: item.id, name: item.name, description: item.description, createdAt: item.createdAt, teamId: item.teamId || null, role: workspaceRole(item, user), files: item.files });
  const audit = (actor, action, target, detail = '') => { db.audit.push({ id: crypto.randomUUID(), actor: actor?.id || null, action, target, detail, createdAt: Date.now() }); db.audit = db.audit.slice(-5000); };
  const activity = (user, action, target, detail, projectId) => { const item = { id: crypto.randomUUID(), user: user.name, initials: user.initials, action, target, detail, projectId, createdAt: Date.now() }; db.activity.unshift(item); db.activity = db.activity.slice(0, 200); return item; };
  const safePath = (value) => { const normalized = normalize(String(value || '')).replaceAll('\\', '/'); return normalized && normalized !== '.' && !normalized.startsWith('../') && !normalized.startsWith('/') && !/^[a-zA-Z]:/.test(normalized) && !normalized.includes('/../') ? normalized : null; };
  const recordHistory = (item, path, content, actor, kind = 'edit', uid = null) => {
    const list = (db.history[item.id] ||= []); const before = list.length;
    appendHistory(list, { id: crypto.randomUUID(), path, content, actor, kind, createdAt: Date.now(), uid });
    const dropped = before + 1 - list.length; if (dropped > 0 && db.snapshots?.[item.id]) db.snapshots[item.id].historyLength = Math.max(0, db.snapshots[item.id].historyLength - dropped);
  };

  const masterKeyForSigning = loadMasterKey(join(dirname(stateFile), 'master.key'));
  const collab = createCollab({ db, recordHistory, save });
  const runLimiter = createRateLimiter({ limit: 30, windowMs: 60 * 1000 });
  const agentLimiter = createRateLimiter({ limit: 20, windowMs: 60 * 1000 });
  const social = createSocial({ db, json, fail, audit, save, notify: (...a) => notify(...a), project, team });
  const platform = createPlatform({ db, json, fail, audit, activity, collab, save, notify: () => {}, project, runner, limiter: runLimiter, broadcast: (id, m) => broadcast(id, m), signingKey: masterKeyForSigning, allowInsecureTunnels });

  const notify = (userId, text, ref) => { db.notifications.push({ id: crypto.randomUUID(), userId, text, ref, read: false, at: Date.now() }); db.notifications = db.notifications.slice(-5000); };
  const events = createEvents({ db, json, fail, audit, activity, collab, save, recordHistory, notify });
  // Team hub (Nexconn): channels, threads, handover, direct messages. The shared assistant answers through the same checks as the workspace assistant.
  const askAssistant = async (user, item, prompt) => {
    const stop = (status, message) => Object.assign(new Error(message), { status });
    if (platform.settings.killSwitch) throw stop(503, 'Agents are disabled by an administrator'); if (platform.eventPolicyBlocks(item)) throw stop(403, 'This event does not allow AI agents');
    if (!agentLimiter(`agent:${user.id}`)) throw stop(429, 'The assistant is limited to 20 requests a minute. Wait a moment.');
    try { const result = await agentRequest(prompt, item.files, { config: platform.aiConfigFor(user), allowPrivate: platform.allowPrivateAi() }); return { message: result.message, provider: result.provider }; } catch (error) { throw stop(502, error.message || 'The assistant could not answer'); }
  };
  const nexconn = createNexconn({ db, json, save, project, askAssistant, audit, ...nexconnOptions });
  const repoInfoCache = new Map();
  const tracker = createTracker({ db, json, save, notify });

  // ---- realtime rooms
  const rooms = new Map();
  const clients = (id) => rooms.get(id) || new Set();
  const broadcast = (id, message, except) => { for (const client of clients(id)) if (client !== except && client.readyState === 1) client.send(JSON.stringify(message)); };
  const roomPresence = (id) => [...clients(id)].filter((client) => !client.isCall).map((client) => ({ id: client.user.id, name: client.user.name, initials: client.user.initials, file: client.file || null }));
  const broadcastPresence = (id) => broadcast(id, { type: 'presence', members: roomPresence(id) });
  const kickMember = (projectId, userId) => { collab.kick(projectId, userId); for (const client of clients(projectId)) if (client.user.id === userId) client.close(4403, 'Access revoked'); };

  // ---- sessions
  const sessionUser = (req) => {
    const now = Date.now(); req.token = null;
    const bearer = /^Bearer (hc_[A-Za-z0-9_-]+)$/.exec(String(req.headers.authorization || ''));
    if (bearer) {
      const rec = db.tokens.find((t) => t.hash === sha256(bearer[1]) && !t.revoked && t.expiresAt > now); if (!rec) return null;
      const owner = db.users.find((user) => user.id === rec.userId); if (!owner || owner.suspended) return null; req.token = rec; return owner;
    }
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]; if (!token) return null;
    const hash = sha256(token);
    const session = db.sessions.find((item) => item.hash === hash && item.expiresAt > now); if (!session) return null;
    const found = db.users.find((user) => user.id === session.userId) || null; return found && !found.suspended ? found : null;
  };
  const wsTickets = new Map(); const callInviteLimiter = createRateLimiter({ limit: 10, windowMs: 60 * 1000 });
  const allowedOrigins = new Set([process.env.HACKCONNECT_BASE_URL, ...String(process.env.HACKCONNECT_ALLOWED_ORIGINS || '').split(',')].map((v) => String(v || '').trim().replace(/\/+$/, '')).filter(Boolean));
  /** Live sockets: a normal session cookie (same address) or a one-time ticket (frontend on another address). Returns null when neither is valid. */
  const socketUser = (req, url) => {
    const origin = req.headers.origin; const sameSite = !origin || new URL(origin).host === req.headers.host;
    const ticket = url.searchParams.get('ticket');
    if (ticket) {
      const key = sha256(ticket); const rec = wsTickets.get(key); wsTickets.delete(key);
      if (!rec || rec.exp < Date.now() || !(sameSite || allowedOrigins.has(origin))) return null;
      const owner = db.users.find((u) => u.id === rec.userId); return owner && !owner.suspended ? owner : null;
    }
    return sameSite ? sessionUser(req) : null;
  };
  // Behind Render/Vercel every request arrives from the platform's proxy, so rate limits need the real visitor address.
  const clientIp = (req) => (process.env.HACKCONNECT_TRUST_PROXY === 'true' && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
  const isHttps = makeIsHttps({ secureCookies });
  const startSession = (res, user, req) => {
    const token = newToken(); db.sessions = db.sessions.filter((item) => item.expiresAt > Date.now());
    db.sessions.push({ hash: sha256(token), userId: user.id, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS, agent: String(req.headers['user-agent'] || '').slice(0, 200) });
    return { 'set-cookie': sessionCookie(token, { secure: isHttps(req) }) };
  };
  const mailer = createMailer({ outboxDir: join(dirname(stateFile), 'outbox'), log: (m) => console.log(m) });
  // With a real mail server, unverified accounts cannot sign in. Without one (local dev) verification is optional.
  const requireVerified = process.env.HACKCONNECT_REQUIRE_VERIFIED ? process.env.HACKCONNECT_REQUIRE_VERIFIED === 'true' : mailer.mode === 'smtp';
  const publicBase = (req) => (process.env.HACKCONNECT_BASE_URL || `${isHttps(req) ? 'https' : 'http'}://${req.headers.host || 'localhost'}`).replace(/\/+$/, '');
  const issueToken = (user, field, ttlMs) => { const token = newToken(); user[field] = { hash: sha256(token), expires: Date.now() + ttlMs, sentAt: Date.now() }; return token; };
  const sendMailSafe = (mail) => mailer.send(mail).catch((error) => console.error('mail failed:', error.message));
  const sendVerification = (req, user) => { const token = issueToken(user, 'verify', 24 * 3600 * 1000); return sendMailSafe({ to: user.email, subject: 'Confirm your HackConnect email', text: `Hi ${user.name},\n\nConfirm your email address to finish setting up your account:\n${publicBase(req)}/?verify=${token}\n\nThis link expires in 24 hours. If you did not sign up, ignore this message.` }); };
  const masterKey = loadMasterKey(join(dirname(stateFile), 'master.key'));
  const oauth = createOAuth({ db, masterKey, audit, save, startSession, isHttps, port: Number(process.env.PORT || 4173) });
  const importLimiter = createRateLimiter({ limit: 6, windowMs: 60 * 1000 });
  const projectsApi = createProjects({ db, json, fail, audit, activity, collab, save, project, githubTokenFor: (user) => oauth.githubTokenFor(user, (value) => decrypt(masterKey, value)), importLimiter });
  const requireProject = (user, id, action) => {
    const item = project(id); if (!item || workspaceRole(item, user) === null) throw fail(404, 'Project not found'); // 404 hides existence
    if (!can(user, action, item)) throw fail(403, 'You do not have permission to do that');
    return item;
  };
  const requireTeam = (user, id, action) => {
    const item = team(id); if (!item || !item.members[user.id] && user.role !== 'admin') throw fail(404, 'Team not found');
    if (!teamCan(user, action, item)) throw fail(403, 'You do not have permission to do that');
    return item;
  };
  const inviteLink = (invite, token) => ({ id: invite.id, token, kind: invite.kind, role: invite.role, expiresAt: invite.expiresAt });

  async function api(req, res, pathname) {
    const ip = clientIp(req);
    const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    // CSRF: cookies are SameSite=Lax and every mutation must carry a header browsers refuse to send cross-site without CORS.
    if (mutating && !/^Bearer hc_/.test(String(req.headers.authorization || '')) && !['/api/device/start', '/api/device/token'].includes(pathname) && req.headers['x-requested-with'] !== 'hackconnect') return json(res, 403, { error: 'Missing X-Requested-With header' });
    const body = mutating ? await readBody(req, /\/projects\/[^/]+\/import$/.test(pathname) ? 8_000_000 : 2_000_000) : {};
    const parts = pathname.split('/').filter(Boolean);

    // ---- public auth routes
    if (pathname === '/api/auth/signup' && req.method === 'POST') {
      if (!authLimiter(`auth:${ip}`)) return json(res, 429, { error: 'Too many attempts. Try again later.' });
      const input = validateSignup(body); if (input.error) return json(res, 400, { error: input.error });
      if (db.users.some((user) => user.email === input.email)) return json(res, 409, { error: 'An account with that email already exists' });
      let username = String(body.username ?? '').trim().toLowerCase().replace(/^@/, '');
      if (username) { if (!isValidUsername(username)) return json(res, 400, { error: 'Usernames are 3-30 characters: lowercase letters, numbers, - and _, starting with a letter or number.' }); if (db.users.some((u) => u.username === username)) return json(res, 409, { error: 'That username is already taken. Try another.' }); } else username = makeUsername(db, input.name, input.email);
      const user = { id: crypto.randomUUID(), username, name: input.name, initials: initialsOf(input.name), email: input.email, passwordHash: hashPassword(input.password), emailVerified: false, role: db.users.length === 0 ? 'admin' : 'user', createdAt: Date.now() };
      db.users.push(user);
      audit(user, 'auth.signup', user.id); const headers = requireVerified ? {} : startSession(res, user, req); await sendVerification(req, user); save();
      return json(res, 201, { user: publicUser(user), needsVerification: requireVerified, delivery: mailer.mode }, headers);
    }
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      if (!authLimiter(`auth:${ip}`)) return json(res, 429, { error: 'Too many attempts. Try again later.' });
      const email = String(body.email || '').trim().toLowerCase(); const user = db.users.find((item) => item.email === email);
      const ok = verifyPassword(String(body.password || ''), user ? user.passwordHash : DUMMY_HASH); // constant work either way
      if (user?.lock?.until > Date.now()) return json(res, 429, { error: `Too many failed attempts. This account is locked for ${Math.ceil((user.lock.until - Date.now()) / 60000)} more minute(s).` });
      if (!user || !ok) {
        if (user) { user.lock = { fails: (user.lock?.fails || 0) + 1, until: 0 }; if (user.lock.fails >= 5) { user.lock = { fails: 0, until: Date.now() + 10 * 60000 }; audit(user, 'auth.locked', user.id); } }
        audit(null, 'auth.login_failed', email.slice(0, 80)); save(); return json(res, 401, { error: 'Invalid email or password' });
      }
      if (user.lock) delete user.lock; // persisted in the state file, so restarts do not reset it
      if (requireVerified && user.emailVerified === false) return json(res, 403, { error: 'Please confirm your email first: open the link we sent you.', needsVerification: true });
      audit(user, 'auth.login', user.id); const headers = startSession(res, user, req); save();
      return json(res, 200, { user: publicUser(user) }, headers);
    }
    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]; if (token) { db.sessions = db.sessions.filter((item) => item.hash !== sha256(token)); save(); }
      return json(res, 200, { ok: true }, { 'set-cookie': sessionCookie('', { secure: isHttps(req), maxAgeMs: 0 }) });
    }

    if (pathname === '/api/auth/verify' && req.method === 'POST') {
      const hash = sha256(String(body.token || '')); const target = db.users.find((u) => u.verify?.hash === hash && u.verify.expires > Date.now());
      if (!target) return json(res, 400, { error: 'This confirmation link is invalid or has expired. Sign in and request a new one.' });
      target.emailVerified = true; delete target.verify; audit(target, 'auth.email_verified', target.id); save(); return json(res, 200, { ok: true });
    }
    if (pathname === '/api/auth/forgot' && req.method === 'POST') {
      if (!authLimiter(`forgot:${ip}`)) return json(res, 429, { error: 'Too many attempts. Try again later.' });
      const target = db.users.find((u) => u.email === String(body.email || '').trim().toLowerCase());
      if (target && !(target.reset?.sentAt > Date.now() - 60000)) { const token = issueToken(target, 'reset', 3600 * 1000); audit(target, 'auth.reset_requested', target.id); save(); await sendMailSafe({ to: target.email, subject: 'Reset your HackConnect password', text: `Hi ${target.name},\n\nChoose a new password here:\n${publicBase(req)}/?reset=${token}\n\nThis link works once and expires in 1 hour. If you did not ask for this, ignore this message: your password has not changed.` }); }
      return json(res, 200, { ok: true, delivery: mailer.mode }); // same answer whether or not the account exists
    }
    if (pathname === '/api/auth/reset' && req.method === 'POST') {
      if (!authLimiter(`reset:${ip}`)) return json(res, 429, { error: 'Too many attempts. Try again later.' });
      const password = body.password; if (typeof password !== 'string' || password.length < 10 || password.length > 200) return json(res, 400, { error: 'Password must be at least 10 characters' });
      const hash = sha256(String(body.token || '')); const target = db.users.find((u) => u.reset?.hash === hash && u.reset.expires > Date.now());
      if (!target) return json(res, 400, { error: 'This reset link is invalid or has expired. Request a new one.' });
      target.passwordHash = hashPassword(password); target.emailVerified = true; delete target.reset; delete target.lock; db.sessions = db.sessions.filter((s) => s.userId !== target.id); // proves mailbox control; signs out every device
      audit(target, 'auth.password_reset', target.id); save(); return json(res, 200, { ok: true });
    }
    if (pathname === '/api/auth/username-available' && req.method === 'GET') {
      if (!authLimiter(`uname:${ip}`)) return json(res, 429, { error: 'Slow down' });
      const wanted = String(new URL(req.url, 'http://x').searchParams.get('u') || '').trim().toLowerCase().replace(/^@/, ''); const valid = isValidUsername(wanted);
      return json(res, 200, { valid, available: valid && !db.users.some((u) => u.username === wanted), suggestion: valid ? null : makeUsername(db, wanted, 'builder') });
    }
    if (pathname === '/api/auth/providers' && req.method === 'GET') return json(res, 200, { providers: oauth.providers() });
    if (parts[0] === 'api' && parts[1] === 'auth' && parts[2] === 'oauth' && parts[3] && req.method === 'GET') {
      const target = new URL(req.url, 'http://localhost');
      // Google/GitHub only accept the exact callback URL you registered (http://localhost:PORT/...), and the sign-in cookie
      // belongs to one host. If the page was opened as 127.0.0.1 or [::1], restart the flow on "localhost" so everything matches.
      const loopbackIp = /^(127\.0\.0\.1|\[::1\])(:\d+)?$/.exec(String(req.headers.host || ''));
      if (canonicalLocalhost && loopbackIp && !process.env.HACKCONNECT_BASE_URL && parts[4] === 'start') { res.writeHead(302, { location: `http://localhost${loopbackIp[2] || ''}${req.url}`, 'cache-control': 'no-store' }); return res.end(); }
      if (parts[4] === 'start') return oauth.start(req, res, parts[3], target, sessionUser(req));
      if (parts[4] === 'callback') { if (!authLimiter(`oauth:${ip}`)) return json(res, 429, { error: 'Too many attempts. Try again later.' }); return await oauth.callback(req, res, parts[3], target, sessionUser(req)); }
    }
    if (pathname === '/api/device/start' && req.method === 'POST') { if (!authLimiter(`device:${ip}`)) return json(res, 429, { error: 'Too many attempts. Try again later.' }); return json(res, 200, platform.deviceStart()); }
    if (pathname === '/api/device/token' && req.method === 'POST') { const r = platform.deviceToken(body.deviceCode); return json(res, r.status, r.body); }

    // ---- everything below needs a session
    const user = sessionUser(req);
    // Split deployment (frontend on Vercel, backend on Render): the browser's cookie belongs to the frontend's address, so a live
    // socket opened straight to the backend proves who it is with a one-time ticket obtained through the normal signed-in API.
    if (pathname === '/api/ws-ticket' && req.method === 'POST') { if (!user) return json(res, 401, { error: 'Not signed in' }); const ticket = newToken(); const now = Date.now(); for (const [k, v] of wsTickets) if (v.exp < now) wsTickets.delete(k); wsTickets.set(sha256(ticket), { userId: user.id, exp: now + 60000 }); return json(res, 200, { ticket }); }
    if (pathname === '/api/auth/me' && req.method === 'GET') return user ? json(res, 200, { user: publicUser(user) }) : json(res, 401, { error: 'Not signed in' });
    if (!user) return json(res, 401, { error: 'Sign in to continue' });
    if (req.token && !(pathname === '/api/auth/me' || pathname === '/api/bootstrap' || parts[1] === 'projects')) return json(res, 403, { error: 'This token cannot access that route' });
    if (req.token && req.token.kind !== 'bridge') return json(res, 403, { error: 'This token is only valid for the MCP endpoint' });
    if (mutating && !writeLimiter(`w:${user.id}`)) return json(res, 429, { error: 'Slow down: too many requests' });

    if (pathname === '/api/auth/resend-verification' && req.method === 'POST') {
      if (user.emailVerified !== false) return json(res, 200, { ok: true, alreadyVerified: true });
      if (user.verify?.sentAt > Date.now() - 60000) return json(res, 429, { error: 'A link was just sent. Wait a minute before asking again.' });
      await sendVerification(req, user); save(); return json(res, 200, { ok: true, delivery: mailer.mode });
    }
    if (pathname === '/api/me/identities' && req.method === 'GET') return json(res, 200, { identities: oauth.identitiesOf(user), providers: oauth.providers(), hasPassword: Boolean(user.passwordHash) });
    if (parts[1] === 'auth' && parts[2] === 'identities' && parts[3] && req.method === 'DELETE') { if (req.token) return json(res, 403, { error: 'Use the web app to disconnect accounts' }); const out = oauth.unlink(user, parts[3]); return json(res, out.status, out.body); }
    if (pathname === '/api/integrations/status' && req.method === 'GET') return json(res, 200, { agent: process.env.HACKCONNECT_AGENT_PROVIDER || 'demo', github: oauth.identitiesOf(user).some((i) => i.provider === 'github' && i.hasRepoAccess), githubSignIn: oauth.providers().github, realtime: true });
    if (pathname === '/api/github/repos' && req.method === 'GET') { // the signed-in user's own GitHub repositories (needs the GitHub sign-in / connection)
      const token = oauth.githubTokenFor(user, (value) => decrypt(masterKey, value)); if (!token) return json(res, 200, { connected: false, repos: [] });
      const api = (process.env.HACKCONNECT_GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''); const repos = [];
      try { for (let page = 1; page <= 5; page++) { const r = await fetch(`${api}/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator&page=${page}`, { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'HackConnect', 'x-github-api-version': '2022-11-28' }, signal: AbortSignal.timeout(15000) }); if (!r.ok) { if (page === 1) return json(res, 502, { error: r.status === 401 ? 'GitHub rejected the saved connection. Reconnect GitHub.' : `GitHub answered ${r.status}` }); break; } const batch = await r.json(); repos.push(...batch.map((x) => ({ owner: x.owner.login, name: x.name, fullName: x.full_name, description: x.description || '', private: x.private, fork: x.fork, language: x.language || '', pushedAt: x.pushed_at, branch: x.default_branch, size: x.size }))); if (batch.length < 100) break; } } catch (error) { return json(res, 502, { error: 'Could not reach GitHub' }); }
      return json(res, 200, { connected: true, repos });
    }
    if (pathname === '/api/github/repo-info' && req.method === 'GET') { // languages + which contributors are HackConnect members (matched by their connected GitHub handle)
      const token = oauth.githubTokenFor(user, (value) => decrypt(masterKey, value)); const q = new URL(req.url, 'http://x').searchParams; const owner = q.get('owner') || ''; const repo = q.get('repo') || ''; const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
      if (!token || !NAME.test(owner) || !NAME.test(repo)) return json(res, 400, { error: 'Connect GitHub and choose a repository' });
      const key = `${user.id}:${owner}/${repo}`; const hit = repoInfoCache.get(key); if (hit && Date.now() - hit.at < 600000) return json(res, 200, hit.data);
      const api = (process.env.HACKCONNECT_GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''); const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'HackConnect', 'x-github-api-version': '2022-11-28' };
      const get = (path) => fetch(`${api}/repos/${owner}/${repo}/${path}`, { headers, signal: AbortSignal.timeout(15000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const [langs, contribs] = await Promise.all([get('languages'), get('contributors?per_page=50')]);
      const total = Object.values(langs || {}).reduce((n, v) => n + v, 0);
      const languages = Object.entries(langs || {}).sort((a, b) => b[1] - a[1]).map(([language, bytes]) => ({ language, bytes, color: colorOfLanguage(language), percent: total ? Math.round((bytes / total) * 1000) / 10 : 0 }));
      const logins = new Set((Array.isArray(contribs) ? contribs : []).map((c) => String(c.login || '').toLowerCase())); const ids = db.identities.filter((i) => i.provider === 'github' && logins.has(String(i.handle || '').toLowerCase()));
      let people = ids.map((i) => db.users.find((u) => u.id === i.userId)).filter(Boolean).map((u) => ({ id: u.id, username: u.username, name: u.name, initials: u.initials }));
      if (!people.some((p) => p.id === user.id)) people.unshift({ id: user.id, username: user.username, name: user.name, initials: user.initials }); // you are always shown; GitHub-only contributors are not
      const data = { languages, contributors: people, githubContributors: logins.size }; repoInfoCache.set(key, { at: Date.now(), data }); return json(res, 200, data);
    }
    if (pathname === '/api/bootstrap' && req.method === 'GET') {
      const mine = db.projects.filter((item) => workspaceRole(item, user) !== null); const ids = new Set(mine.map((item) => item.id));
      return json(res, 200, { user: publicUser(user), projects: mine.map((item) => publicProject(item, user)), activity: db.activity.filter((item) => ids.has(item.projectId)).slice(0, 50), teams: db.teams.filter((item) => item.members[user.id]).map((item) => ({ id: item.id, name: item.name, role: item.members[user.id] })), integrations: { nexconn: nexconn.enabled(), agent: process.env.HACKCONNECT_AGENT_PROVIDER || 'demo', github: oauth.identitiesOf(user).some((i) => i.provider === 'github' && i.hasRepoAccess) } });
    }

    const socialRoute = ['users', 'invitations', 'connections'].includes(parts[1]) || (parts[1] === 'me' && ((parts.length === 2 && req.method === 'PATCH') || ['invitations', 'connections'].includes(parts[2]))) || (['projects', 'teams'].includes(parts[1]) && parts[3] === 'invite-user');
    if (socialRoute && await social({ req, res, user, parts, body })) return;
    if (parts[1] === 'nexconn' || parts[1] === 'hub' || (parts[1] === 'projects' && parts[3] === 'channels')) { if (await nexconn.handle({ req, res, user, parts, body })) return; }
    if (parts[1] === 'projects' && parts[2] && (['import', 'import-github', 'overview', 'tree', 'file', 'export.zip'].includes(parts[3]) || (parts[3] === 'files' && (req.method === 'DELETE' || ['mkdir', 'rename'].includes(parts[4]))))) { if (await projectsApi({ req, res, user, parts, body })) return; }
    if (parts[1] === 'me' && parts[2] === 'avatar') { // profile photo: a small JPEG/PNG/WebP data URL produced by the browser
      if (req.method === 'POST') { const img = String(body.image || ''); if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(img) || img.length > 150000) return json(res, 400, { error: 'Choose a smaller image (JPEG, PNG or WebP)' }); user.avatar = img; save(); return json(res, 200, { avatar: img }); }
      if (req.method === 'DELETE') { user.avatar = ''; save(); return json(res, 200, { avatar: '' }); }
    }
    if (parts[1] === 'me' && parts[2] === 'hackathons') { if (await tracker({ req, res, user, parts, body })) return; }
    if (parts[1] === 'projects' && parts.length === 3 && req.method === 'DELETE' && nexconn.enabled()) { const doomed = project(parts[2]); if (doomed?.channels?.length) res.on('finish', () => { if (!project(parts[2])) nexconn.dropProject(doomed); }); } // a deleted project takes its Nexconn channels with it
    if (['device', 'reports', 'me', 'admin'].includes(parts[1]) || (parts[1] === 'projects' && (['tokens', 'proposals', 'tunnels', 'call-token', 'run'].includes(parts[3]) || (parts.length === 3 && ['PATCH', 'DELETE'].includes(req.method))))) { if (await platform.handle({ req, res, user, parts, body })) return; }
    if (parts[0] === 'api' && (parts[1] === 'events' || parts[1] === 'gallery' || parts[1] === 'notifications')) { if (await events({ req, res, user, parts, body })) return; }

    // ---- teams
    if (pathname === '/api/teams' && req.method === 'POST') {
      const name = String(body.name || '').trim(); if (!name || name.length > 80) return json(res, 400, { error: 'Team name is required (max 80 characters)' });
      const item = { id: crypto.randomUUID(), name, members: { [user.id]: 'owner' }, createdAt: Date.now() }; db.teams.push(item); audit(user, 'team.create', item.id, name); save();
      return json(res, 201, { id: item.id, name, role: 'owner' });
    }
    if (parts[0] === 'api' && parts[1] === 'teams' && parts[2]) {
      const item = requireTeam(user, parts[2], 'team.read');
      if (parts.length === 3 && req.method === 'GET') return json(res, 200, { id: item.id, name: item.name, members: Object.entries(item.members).map(([id, role]) => { const u = db.users.find((x) => x.id === id); return { id, role, name: u?.name, initials: u?.initials }; }) });
      if (parts[3] === 'invites' && req.method === 'POST') {
        requireTeam(user, item.id, 'team.invite'); const role = body.role === undefined ? 'member' : body.role; if (!isTeamRole(role)) return json(res, 400, { error: 'Invalid role' });
        const token = newToken(); const invite = { id: crypto.randomUUID(), kind: 'team', targetId: item.id, role, hash: sha256(token), createdBy: user.id, expiresAt: Date.now() + INVITE_TTL_MS };
        db.invites.push(invite); audit(user, 'invite.create', item.id, `team:${role}`); save(); return json(res, 201, inviteLink(invite, token));
      }
    }

    // ---- invites (accepting grants the role stored on the invite, never one from the request)
    if (parts[0] === 'api' && parts[1] === 'invites' && parts[2] && parts[3] === 'accept' && req.method === 'POST') {
      const hash = sha256(parts[2]); const invite = db.invites.find((item) => item.hash === hash);
      if (!invite || invite.expiresAt < Date.now()) return json(res, 404, { error: 'This invite is invalid or has expired' });
      if (invite.kind === 'team') {
        const target = team(invite.targetId); if (!target) return json(res, 404, { error: 'Team no longer exists' });
        if (!target.members[user.id]) target.members[user.id] = invite.role;
        audit(user, 'invite.accept', target.id, 'team'); save(); return json(res, 200, { kind: 'team', id: target.id, name: target.name });
      }
      const target = project(invite.targetId); if (!target) return json(res, 404, { error: 'Project no longer exists' });
      if (!target.members[user.id]) target.members[user.id] = invite.role;
      audit(user, 'invite.accept', target.id, `workspace:${invite.role}`); save(); return json(res, 200, { kind: 'workspace', id: target.id, name: target.name });
    }

    // ---- projects
    if (pathname === '/api/projects' && req.method === 'POST') {
      const name = String(body.name || '').trim(); if (!name || name.length > 80) return json(res, 400, { error: 'Project name is required (max 80 characters)' });
      const plan = PLANS[user.plan || 'free']; if (db.projects.filter((item) => item.members[user.id] === 'owner' && !item.eventId).length >= plan.workspaces) return json(res, 402, { error: `Your ${user.plan || 'free'} plan allows ${plan.workspaces} workspaces. Delete one or upgrade.` });
      const members = { [user.id]: 'owner' }; let teamId = null;
      if (body.teamId) { const owningTeam = requireTeam(user, String(body.teamId), 'team.manage'); teamId = owningTeam.id; for (const id of Object.keys(owningTeam.members)) if (!members[id]) members[id] = 'editor'; }
      const description = String(body.description || 'New collaborative build room').slice(0, 300);
      const item = { id: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project'}-${Date.now().toString(36)}`, name, description, createdAt: Date.now(), teamId, members, legacy: false, files: { 'README.md': `# ${name}\n\n${description}\n` } };
      db.projects.unshift(item); db.messages[item.id] = []; db.history[item.id] = []; recordHistory(item, 'README.md', item.files['README.md'], user.name, 'file_created');
      const event = activity(user, 'created project', name, item.description, item.id); audit(user, 'workspace.create', item.id, name); save();
      return json(res, 201, publicProject(item, user));
    }
    if (parts[0] === 'api' && parts[1] === 'projects' && parts[2]) {
      const probe = project(parts[2]); if (!probe || workspaceRole(probe, user) === null) return json(res, 404, { error: 'Project not found' });
      const item = probe; const sub = parts[3];
      if (parts.length === 3 && req.method === 'GET') { requireProject(user, item.id, 'workspace.read'); return json(res, 200, { project: publicProject(item, user), messages: db.messages[item.id] || [] }); }
      if (sub === 'replay' && req.method === 'GET') { requireProject(user, item.id, 'workspace.read'); return json(res, 200, { projectId: item.id, events: db.history[item.id] || [] }); }
      if (sub === 'members' && parts.length === 4 && req.method === 'GET') { requireProject(user, item.id, 'workspace.read'); return json(res, 200, { members: Object.entries(item.members).map(([id, role]) => { const u = db.users.find((x) => x.id === id); return { id, role, name: u?.name, username: u?.username, initials: u?.initials }; }) }); }
      if (sub === 'members' && parts[4]) {
        requireProject(user, item.id, 'workspace.manage'); const targetId = parts[4]; const current = item.members[targetId]; if (!current) return json(res, 404, { error: 'Member not found' });
        const owners = Object.values(item.members).filter((role) => role === 'owner').length;
        if (req.method === 'PATCH') { if (!isWorkspaceRole(body.role)) return json(res, 400, { error: 'Invalid role' }); if (current === 'owner' && body.role !== 'owner' && owners === 1) return json(res, 409, { error: 'A workspace needs at least one owner' }); item.members[targetId] = body.role; audit(user, 'member.role', item.id, `${targetId}:${body.role}`); save(); return json(res, 200, { id: targetId, role: body.role }); }
        if (req.method === 'DELETE') { if (current === 'owner' && owners === 1) return json(res, 409, { error: 'A workspace needs at least one owner' }); delete item.members[targetId]; audit(user, 'member.remove', item.id, targetId); save(); kickMember(item.id, targetId); return json(res, 200, { ok: true }); }
      }
      if (sub === 'invites' && req.method === 'POST') {
        requireProject(user, item.id, 'workspace.invite'); const role = body.role === undefined ? 'editor' : body.role; if (!isWorkspaceRole(role)) return json(res, 400, { error: 'Invalid role' });
        const token = newToken(); const invite = { id: crypto.randomUUID(), kind: 'workspace', targetId: item.id, role, hash: sha256(token), createdBy: user.id, expiresAt: Date.now() + INVITE_TTL_MS };
        db.invites.push(invite); audit(user, 'invite.create', item.id, `workspace:${role}`); save(); return json(res, 201, inviteLink(invite, token));
      }
      // "Come join the call": every chosen teammate (default: everyone else) gets an inbox message with a join action, and a live prompt if they have the project open.
      if (sub === 'call-invite' && !parts[4] && req.method === 'POST') {
        requireProject(user, item.id, 'workspace.chat');
        if (!callInviteLimiter(`callinv:${user.id}`)) return json(res, 429, { error: 'You just sent several call invites. Wait a minute and try again.' });
        const CHANNEL_NAMES = { general: 'General', standup: 'Standup', focus: 'Focus room', pair: 'Pair programming' }; const channel = CHANNEL_NAMES[body.channel] ? body.channel : 'general';
        const others = Object.keys(item.members).filter((id) => id !== user.id); const wanted = Array.isArray(body.userIds) && body.userIds.length ? body.userIds.map(String) : others; const targets = wanted.filter((id) => others.includes(id));
        if (!targets.length) return json(res, 400, { error: 'There is nobody to invite yet. Add teammates to this project first.' });
        const at = Date.now(); const ids = {};
        for (const id of targets) { const rec = { id: crypto.randomUUID(), userId: id, text: `${user.name} invited you to join the call "${CHANNEL_NAMES[channel]}" in ${item.name}`, ref: { type: 'call', kind: 'call', projectId: item.id, projectName: item.name, channel, by: user.id, byName: user.name }, read: false, at }; db.notifications.push(rec); ids[id] = rec.id; }
        db.notifications = db.notifications.slice(-5000); audit(user, 'call.invite', item.id, `${channel}:${targets.length}`); save();
        broadcast(item.id, { type: 'call.invite', ids, projectId: item.id, projectName: item.name, channel, channelName: CHANNEL_NAMES[channel], byName: user.name, by: user.id });
        return json(res, 200, { invited: targets.length });
      }
      if (sub === 'messages' && !parts[4] && req.method === 'POST') {
        requireProject(user, item.id, 'workspace.chat'); const text = String(body.text || '').trim(); if (!text) return json(res, 400, { error: 'Message is required' }); if (text.length > 4000) return json(res, 413, { error: 'Message is too long' });
        const message = { id: crypto.randomUUID(), userId: user.id, user: user.name, initials: user.initials, text, createdAt: Date.now(), ...(body.sticker === true && [...text].length <= 4 ? { sticker: true } : {}) };
        db.messages[item.id] ||= []; db.messages[item.id].push(message); save(); broadcast(item.id, { type: 'message.created', message }); return json(res, 201, message);
      }
      if (sub === 'messages' && parts[4] && parts[5] === 'react' && req.method === 'POST') { // toggle your emoji reaction on a message
        requireProject(user, item.id, 'workspace.chat'); const emoji = String(body.emoji || '').trim(); if (!emoji || [...emoji].length > 8) return json(res, 400, { error: 'Pick an emoji' });
        const message = (db.messages[item.id] || []).find((m) => m.id === parts[4]); if (!message) return json(res, 404, { error: 'Message not found' });
        message.reactions ||= {}; const list = (message.reactions[emoji] ||= []); const at = list.indexOf(user.id); if (at >= 0) list.splice(at, 1); else if (Object.keys(message.reactions).length < 12) list.push(user.id); if (!list.length) delete message.reactions[emoji];
        save(); broadcast(item.id, { type: 'message.updated', message }); return json(res, 200, message);
      }
      if (sub === 'files' && req.method === 'PUT') {
        requireProject(user, item.id, 'workspace.write'); const filePath = safePath(body.path); if (!filePath) return json(res, 400, { error: 'Safe relative file path is required' });
        if (typeof body.content !== 'string') return json(res, 400, { error: 'File content must be a string' }); if (body.content.length > 500_000) return json(res, 413, { error: 'File is too large' });
        if (isSensitivePath(filePath) && body.allowSensitive !== true) return json(res, 422, { error: `${filePath} looks like a secrets file and was not saved. Use workspace environment variables instead.` });
        const secretWarnings = scanSecrets(body.content);
        collab.writeFile(item, filePath, body.content, user.name, item.files[filePath] === undefined ? 'file_created' : 'edit', user.id);
        const event = activity(user, 'updated', `${item.name}/${filePath}`, 'Saved from the live workspace', item.id); save();
        broadcast(item.id, { type: 'file.updated', path: filePath, content: body.content, user: user.name, at: Date.now() }); broadcast(item.id, { type: 'activity.created', item: event });
        return json(res, 200, { path: filePath, content: body.content, warnings: secretWarnings.length ? [`This file appears to contain: ${secretWarnings.join(', ')}. Remove it before sharing or submitting.`] : [] });
      }
      if (sub === 'agent' && req.method === 'POST') {
        requireProject(user, item.id, 'workspace.agent');
        if (platform.settings.killSwitch) return json(res, 503, { error: 'Agents are disabled by an administrator' });
        if (platform.eventPolicyBlocks(item)) return json(res, 403, { error: 'This event does not allow AI agents' });
        try {
          if (!agentLimiter(`agent:${user.id}`)) return json(res, 429, { error: 'The assistant is limited to 20 requests a minute. Wait a moment.' });
          const askText = String(body.prompt || '').slice(0, 8000); const focusPath = typeof body.focus === 'string' ? body.focus : null;
          // Local sign-in providers (Claude Code / Codex on the user's own computer): the browser fetches the prompt, runs it through the local bridge, then sends the answer back here to become diffs/proposals.
          if (body.prepare === true) return json(res, 200, { prompt: buildLocalPrompt(askText, item.files, { history: body.history, focus: focusPath }) });
          const result = typeof body.localText === 'string' ? { provider: ({ claude: 'Claude', codex: 'Codex' })[body.localTool] || 'Local assistant', ...parseAgent(body.localText.slice(0, 300_000)) } : await agentRequest(askText, item.files, { config: platform.aiConfigFor(user), history: body.history, focus: focusPath, allowPrivate: platform.allowPrivateAi() }); const changes = []; const proposals = []; const actor = `HackConnect Agent (for ${user.name})`;
          for (const change of result.changes.slice(0, 20)) {
            const path = safePath(change?.path); if (!path || typeof change.content !== 'string' || change.content.length > 500_000) continue;
            const outcome = platform.applyAgentWrite(item, path, change.content, actor, user);
            if (outcome.applied) { changes.push({ path, content: change.content }); broadcast(item.id, { type: 'file.updated', path, content: change.content, user: 'HackConnect Agent', at: Date.now() }); } else if (outcome.pending) proposals.push({ id: outcome.pending, path });
          }
          const event = activity({ name: 'HackConnect Agent', initials: 'AI' }, 'worked on', item.name, `${result.message} (triggered by ${user.name})`, item.id); save();
          broadcast(item.id, { type: 'agent.completed', result: { ...result, changes, proposals } }); broadcast(item.id, { type: 'activity.created', item: event });
          return json(res, 200, { ...result, changes, proposals });
        } catch (error) { return json(res, 502, { error: error.message }); }
      }
      if (sub === 'github' && parts[4] === 'sync' && req.method === 'POST') {
        requireProject(user, item.id, 'workspace.github');
        try { const result = await githubSync(item, body, oauth.githubTokenFor(user, (value) => decrypt(masterKey, value))); const event = activity(user, 'synced', item.name, `Uploaded ${result.synced} files to ${result.repo}`, item.id); audit(user, 'github.sync', item.id, result.repo); save(); return json(res, 200, { ...result, event }); } catch (error) { return json(res, 502, { error: error.message }); }
      }
    }
    return json(res, 404, { error: 'Route not found' });
  }

  const metrics = { requests: 0, errors5xx: 0 };
  const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; worker-src 'self' blob:; media-src 'self' blob:; connect-src 'self' ws: wss: http://127.0.0.1:47831 http://localhost:47831 https://*.sg-light-edge.com https://*.rongnav.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";
  const server = http.createServer(async (req, res) => {
    const started = Date.now(); const requestId = crypto.randomUUID(); res.setHeader('x-request-id', requestId); metrics.requests++;
    res.on('finish', () => { if (res.statusCode >= 500) metrics.errors5xx++; if (log) console.log(JSON.stringify({ t: new Date().toISOString(), id: requestId, method: req.method, path: String(req.url).split('?')[0], status: res.statusCode, ms: Date.now() - started })); });
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('content-security-policy', CSP); res.setHeader('referrer-policy', 'same-origin'); res.setHeader('x-frame-options', 'DENY');
      if (url.pathname === '/mcp') {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST JSON-RPC to /mcp' });
        const mcpUser = sessionUser(req); if (!mcpUser || !req.token || req.token.kind !== 'mcp') return json(res, 401, { error: 'A workspace MCP token is required (Authorization: Bearer hc_...)' });
        return await platform.handleMcp(req, res, await readBody(req), mcpUser, req.token);
      }
      if (url.pathname.startsWith('/api/')) return await api(req, res, url.pathname);
      if (url.pathname === '/health') return json(res, 200, { ok: true, service: 'hackconnect' });
      if (url.pathname === '/ready') { try { saveNow(); return json(res, 200, { ready: true, storage: 'writable', runner: runner ? runner.name : 'disabled', killSwitch: platform.settings.killSwitch }); } catch (e) { return json(res, 503, { ready: false, error: 'storage not writable' }); } }
      if (url.pathname === '/metrics') {
        if (process.env.HACKCONNECT_METRICS_TOKEN && req.headers.authorization !== `Bearer ${process.env.HACKCONNECT_METRICS_TOKEN}`) return json(res, 401, { error: 'Unauthorized' });
        const live = [...rooms.values()].reduce((n, set) => n + set.size, 0);
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        return res.end(`# TYPE hackconnect_requests_total counter\nhackconnect_requests_total ${metrics.requests}\n# TYPE hackconnect_errors_5xx_total counter\nhackconnect_errors_5xx_total ${metrics.errors5xx}\n# TYPE hackconnect_users gauge\nhackconnect_users ${db.users.length}\n# TYPE hackconnect_workspaces gauge\nhackconnect_workspaces ${db.projects.length}\n# TYPE hackconnect_room_connections gauge\nhackconnect_room_connections ${live}\n`);
      }
      if (url.pathname.startsWith('/vendor/')) {
        const VENDOR = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.ttf': 'font/ttf' };
        const dir = resolve(root, 'vendor'); let file; try { file = resolve(dir, decodeURIComponent(url.pathname.slice('/vendor/'.length))); } catch { return json(res, 404, { error: 'Not found' }); }
        const type = VENDOR[extname(file)]; if (!type || !file.startsWith(dir + sep) || !existsSync(file)) return json(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=3600' }); return res.end(readFileSync(file));
      }
      if (url.pathname === '/download/hackconnect-assistant.zip') { const data = assistantZip(root, publicBase(req), url.searchParams.get('tool') || 'claude'); res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="hackconnect-assistant.zip"', 'content-length': data.length, 'cache-control': 'no-store' }); return res.end(data); }
      if (url.pathname === '/download/hackconnect-bridge.zip' || url.pathname === '/download/hackconnect-vscode.vsix') {
        const origin = (process.env.HACKCONNECT_API_URL || publicBase(req)).replace(/\/+$/, ''); const isZip = url.pathname.endsWith('.zip'); const data = isZip ? bridgeZip(root, origin) : vsix(origin);
        res.writeHead(200, { 'content-type': isZip ? 'application/zip' : 'application/vsix', 'content-disposition': `attachment; filename="${isZip ? 'hackconnect-bridge.zip' : 'hackconnect-vscode.vsix'}"`, 'content-length': data.length, 'cache-control': 'no-store' }); return res.end(data);
      }
      if (PUBLIC_FILES[url.pathname]) { const [file, type] = PUBLIC_FILES[url.pathname]; res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=86400' }); return res.end(readFileSync(join(root, 'public', file))); }
      if (url.pathname.startsWith('/t/')) return await platform.handleTunnel(req, res, url);
      const entry = STATIC[url.pathname]; if (!entry) return json(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-cache' }); res.end(readFileSync(join(root, entry[0])));
    } catch (error) {
      if (error.status) return json(res, error.status, { error: error.message });
      console.error(error); json(res, 500, { error: 'Internal server error' });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  const collabWss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const target = pathname === '/ws' ? wss : pathname === '/collab' ? collabWss : null;
    if (!target) return socket.destroy();
    target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
  });
  collabWss.on('connection', (socket, req) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const wantsBearer = /^Bearer hc_/.test(String(req.headers.authorization || ''));
    const user = wantsBearer ? sessionUser(req) : socketUser(req, url); if (!user) return socket.close(4401, 'Sign in required');
    const item = project(url.searchParams.get('projectId')); if (!item || !can(user, 'workspace.read', item)) return socket.close(4403, 'No access to this project');
    const agentName = req.token ? String(req.headers['x-hc-agent'] || '').slice(0, 40) : '';
    collab.attach(socket, item, user, () => can(user, 'workspace.write', project(item.id)), req.token ? { kind: agentName ? 'agent' : 'bridge', label: agentName ? `${agentName} via Local Bridge (for ${user.name})` : `${user.name} (Local Bridge)` } : null);
  });
  wss.on('connection', (socket, req) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const user = socketUser(req, url); if (!user) return socket.close(4401, 'Sign in required');
    const projectId = url.searchParams.get('projectId'); const item = project(projectId);
    if (!item || !can(user, 'workspace.read', item)) return socket.close(4403, 'No access to this project');
    socket.user = user; socket.isCall = url.searchParams.get('role') === 'call'; rooms.set(projectId, rooms.get(projectId) || new Set()); rooms.get(projectId).add(socket);
    socket.send(JSON.stringify({ type: 'connected', members: roomPresence(projectId) })); if (!socket.isCall) broadcastPresence(projectId);
    socket.on('message', (raw) => {
      try {
        const current = project(projectId); if (!current || !can(user, 'workspace.read', current)) return socket.close(4403, 'Access revoked'); // re-check on every message
        const message = JSON.parse(raw.toString());
        if (message.type === 'presence') { socket.file = safePath(message.file) || socket.file; broadcastPresence(projectId); }
        if (message.type === 'chat.send' && can(user, 'workspace.chat', current)) {
          const text = String(message.text || '').trim().slice(0, 4000); if (!text) return;
          const entry = { id: crypto.randomUUID(), userId: user.id, user: user.name, initials: user.initials, text, createdAt: Date.now() };
          db.messages[projectId] ||= []; db.messages[projectId].push(entry); save(); broadcast(projectId, { type: 'message.created', message: entry });
        }
        if (message.type === 'call.move' && !can(user, 'workspace.write', current)) return;
        if (message.type === 'rtc' || /^call\.[a-z]+$/.test(String(message.type))) { const out = JSON.stringify({ ...message, from: user.id, user: user.name, initials: user.initials }); for (const client of clients(projectId)) if (client.isCall && client !== socket && client.readyState === 1 && (!message.to || message.to === client.user.id)) client.send(out); }
      } catch { socket.send(JSON.stringify({ type: 'error', error: 'Invalid realtime message' })); }
    });
    socket.on('close', () => { if (socket.isCall) { const out = JSON.stringify({ type: 'call.leave', from: user.id, user: user.name }); for (const client of clients(projectId)) if (client.isCall && client !== socket && client.readyState === 1) client.send(out); } rooms.get(projectId)?.delete(socket); if (!rooms.get(projectId)?.size) rooms.delete(projectId); else if (!socket.isCall) broadcastPresence(projectId); });
  });

  const schedulerTimer = setInterval(() => { events.tick(Date.now()); tracker.remindAll(Date.now()); }, 30000); schedulerTimer.unref();
  return { server, db, save, saveNow, backupNow, tick: (now = Date.now()) => events.tick(now), dropCollabConnections: () => { for (const client of collabWss.clients) client.terminate(); }, close: () => new Promise((resolve) => { clearInterval(schedulerTimer); if (backupTimer) clearInterval(backupTimer); collab.destroy(); try { saveNow(); } catch (error) { console.error('final save failed:', error.message); } for (const client of [...wss.clients, ...collabWss.clients]) client.terminate(); wss.close(); collabWss.close(); server.closeAllConnections?.(); server.close(() => resolve()); }) };
}
