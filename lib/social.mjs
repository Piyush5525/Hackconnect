// Usernames, people search, profiles, connection requests, and invitations by username (accept / decline).
import crypto from 'node:crypto';
import { can, teamCan, workspaceRole, isWorkspaceRole, isTeamRole } from './policy.mjs';

export const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{2,29}$/;
const RESERVED = new Set(['admin', 'administrator', 'root', 'support', 'help', 'hackconnect', 'api', 'me', 'system', 'null', 'undefined', 'staff', 'moderator', 'security', 'team', 'teams', 'events', 'about', 'login', 'signup', 'settings']);
export const isValidUsername = (name) => USERNAME_RE.test(name) && !RESERVED.has(name);

const slug = (value) => String(value || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
/** Suggest a free username from a name/email/handle: "Piyush Agarwal" -> piyush-agarwal, then piyush-agarwal-4821 if taken. */
export function makeUsername(db, ...candidates) {
  const taken = (name) => db.users.some((u) => u.username === name) || RESERVED.has(name);
  for (const raw of candidates) { const base = slug(String(raw || '').split('@')[0]); if (base.length >= 3 && !taken(base) && USERNAME_RE.test(base)) return base; }
  const base = slug(candidates.find((c) => slug(String(c || '').split('@')[0]).length >= 2) ? String(candidates.find((c) => slug(String(c || '').split('@')[0]).length >= 2)).split('@')[0] : 'builder') || 'builder';
  for (let i = 0; i < 50; i++) { const name = `${base.slice(0, 22)}-${crypto.randomInt(1000, 9999)}`; if (!taken(name) && USERNAME_RE.test(name)) return name; }
  return `user-${crypto.randomBytes(4).toString('hex')}`;
}

export function createSocial({ db, json, fail, audit, save, notify, project, team }) {
  db.invitations ||= []; db.connections ||= [];
  const byUsername = (name) => db.users.find((u) => u.username === String(name || '').trim().toLowerCase().replace(/^@/, ''));
  const card = (u) => u && { id: u.id, username: u.username, name: u.name, initials: u.initials, avatar: u.avatar || '', bio: u.bio || '' };
  const userById = (id) => db.users.find((u) => u.id === id);

  const connectionState = (a, b) => { const c = db.connections.find((x) => (x.from === a && x.to === b) || (x.from === b && x.to === a)); return c ? { id: c.id, status: c.status, direction: c.from === a ? 'outgoing' : 'incoming' } : null; };
  const invitationView = (inv) => {
    const from = userById(inv.from); let target = null;
    if (inv.kind === 'workspace') { const p = project(inv.targetId); target = p && { id: p.id, name: p.name }; } else { const t = team(inv.targetId); target = t && { id: t.id, name: t.name }; }
    return { id: inv.id, kind: inv.kind, role: inv.role, status: inv.status, at: inv.at, from: card(from), target };
  };

  const send = (res, status, body) => json(res, status, body);

  return async function handle({ req, res, user, parts, body }) {
    const sub = parts[3]; const method = req.method;
    // ---- profile of the signed-in user
    if (parts[1] === 'me' && parts.length === 2 && method === 'PATCH') {
      if (req.token) throw fail(403, 'Edit your profile from the web app');
      if (body.username !== undefined) {
        const next = String(body.username).trim().toLowerCase().replace(/^@/, '');
        if (!isValidUsername(next)) return send(res, 400, { error: 'Usernames are 3-30 characters: lowercase letters, numbers, - and _, starting with a letter or number.' }), true;
        if (next !== user.username) { if (user.usernameChangedAt && Date.now() - user.usernameChangedAt < 60000) return send(res, 429, { error: 'Wait a minute before changing your username again.' }), true; if (byUsername(next)) return send(res, 409, { error: 'That username is already taken.' }), true; user.username = next; user.usernameChangedAt = Date.now(); }
      }
      if (body.name !== undefined) { const name = String(body.name).trim(); if (!name || name.length > 80) return send(res, 400, { error: 'Name must be 1-80 characters' }), true; user.name = name; user.initials = name.split(/\s+/).filter(Boolean).map((p) => p[0]).join('').slice(0, 2).toUpperCase() || '?'; }
      if (body.bio !== undefined) user.bio = String(body.bio).slice(0, 280);
      audit(user, 'profile.update', user.id); save(); return send(res, 200, { user: { id: user.id, username: user.username, name: user.name, initials: user.initials, bio: user.bio || '', email: user.email } }), true;
    }
    // ---- people
    if (parts[1] === 'users' && parts[2] === 'search' && method === 'GET') {
      const q = String(new URL(req.url, 'http://x').searchParams.get('q') || '').trim().toLowerCase().replace(/^@/, ''); if (q.length < 2) return send(res, 200, { users: [] }), true;
      const found = db.users.filter((u) => u.id !== user.id && !u.suspended && (u.username?.startsWith(q) || u.name.toLowerCase().includes(q))).sort((a, b) => (b.username?.startsWith(q) ? 1 : 0) - (a.username?.startsWith(q) ? 1 : 0) || a.username.localeCompare(b.username)).slice(0, 8);
      return send(res, 200, { users: found.map((u) => ({ ...card(u), connection: connectionState(user.id, u.id)?.status || null })) }), true;
    }
    if (parts[1] === 'users' && parts[2] && parts.length === 3 && method === 'GET') {
      const target = byUsername(parts[2]); if (!target || target.suspended) return send(res, 404, { error: 'No user with that username' }), true;
      const shared = db.projects.filter((p) => p.members[target.id] && p.members[user.id]).map((p) => ({ id: p.id, name: p.name }));
      return send(res, 200, { user: { ...card(target), joinedAt: target.createdAt }, connection: connectionState(user.id, target.id), sharedProjects: shared, isSelf: target.id === user.id }), true;
    }
    // ---- connection requests
    if (parts[1] === 'connections' && parts.length === 2 && method === 'POST') {
      const target = byUsername(body.username); if (!target || target.suspended) return send(res, 404, { error: 'No user with that username' }), true; if (target.id === user.id) return send(res, 400, { error: 'You cannot connect with yourself' }), true;
      const existing = connectionState(user.id, target.id); if (existing) return send(res, 409, { error: existing.status === 'accepted' ? 'You are already connected' : 'A request is already pending' }), true;
      if (db.connections.filter((c) => c.from === user.id && c.status === 'pending').length >= 50) return send(res, 429, { error: 'Too many pending requests' }), true;
      const c = { id: crypto.randomUUID(), from: user.id, to: target.id, status: 'pending', at: Date.now() }; db.connections.push(c); notify(target.id, `@${user.username} (${user.name}) sent you a connection request`, `connection:${c.id}`); audit(user, 'connection.request', target.id); save();
      return send(res, 201, { id: c.id, status: 'pending' }), true;
    }
    if (parts[1] === 'me' && parts[2] === 'connections' && method === 'GET') {
      const mine = db.connections.filter((c) => c.from === user.id || c.to === user.id);
      return send(res, 200, { connections: mine.filter((c) => c.status === 'accepted').map((c) => ({ id: c.id, user: card(userById(c.from === user.id ? c.to : c.from)) })), incoming: mine.filter((c) => c.status === 'pending' && c.to === user.id).map((c) => ({ id: c.id, user: card(userById(c.from)), at: c.at })), outgoing: mine.filter((c) => c.status === 'pending' && c.from === user.id).map((c) => ({ id: c.id, user: card(userById(c.to)), at: c.at })) }), true;
    }
    if (parts[1] === 'connections' && parts[2] && ['accept', 'decline'].includes(parts[3]) && method === 'POST') {
      const c = db.connections.find((x) => x.id === parts[2] && x.to === user.id && x.status === 'pending'); if (!c) return send(res, 404, { error: 'Request not found' }), true;
      if (parts[3] === 'accept') { c.status = 'accepted'; notify(c.from, `@${user.username} accepted your connection request`, `connection:${c.id}`); } else db.connections = db.connections.filter((x) => x !== c);
      audit(user, `connection.${parts[3]}`, c.id); save(); return send(res, 200, { status: parts[3] === 'accept' ? 'accepted' : 'declined' }), true;
    }
    if (parts[1] === 'connections' && parts[2] && parts.length === 3 && method === 'DELETE') {
      const c = db.connections.find((x) => x.id === parts[2] && (x.from === user.id || x.to === user.id)); if (!c) return send(res, 404, { error: 'Connection not found' }), true; db.connections = db.connections.filter((x) => x !== c); save(); return send(res, 200, { ok: true }), true;
    }
    // ---- invitations by username
    const makeInvitation = (kind, target, role, toUsername, label) => {
      const to = byUsername(toUsername); if (!to || to.suspended) return { status: 404, body: { error: 'No user with that username' } }; if (to.id === user.id) return { status: 400, body: { error: 'You are already in this ' + label } };
      if (kind === 'workspace' ? target.members[to.id] : target.members[to.id]) return { status: 409, body: { error: `@${to.username} is already a member` } };
      if (db.invitations.some((i) => i.status === 'pending' && i.to === to.id && i.kind === kind && i.targetId === target.id)) return { status: 409, body: { error: `@${to.username} already has a pending invitation` } };
      if (db.invitations.filter((i) => i.from === user.id && i.status === 'pending').length >= 100) return { status: 429, body: { error: 'Too many pending invitations' } };
      const inv = { id: crypto.randomUUID(), kind, targetId: target.id, role, from: user.id, to: to.id, status: 'pending', at: Date.now() }; db.invitations.push(inv);
      notify(to.id, `@${user.username} invited you to join the ${label} "${target.name}" as ${role}`, `invitation:${inv.id}`); audit(user, 'invitation.send', target.id, `${kind}:${role}:${to.id}`); save();
      return { status: 201, body: { id: inv.id, to: card(to), role } };
    };
    if (parts[1] === 'projects' && sub === 'invite-user' && method === 'POST') {
      const p = project(parts[2]); if (!p || workspaceRole(p, user) === null) return send(res, 404, { error: 'Project not found' }), true; if (!can(user, 'workspace.invite', p)) return send(res, 403, { error: 'Only owners can invite people' }), true;
      const role = body.role === undefined ? 'editor' : body.role; if (!isWorkspaceRole(role)) return send(res, 400, { error: 'Invalid role' }), true;
      const out = makeInvitation('workspace', p, role, body.username, 'project'); return send(res, out.status, out.body), true;
    }
    if (parts[1] === 'teams' && sub === 'invite-user' && method === 'POST') {
      const t = team(parts[2]); if (!t || !(t.members[user.id] || user.role === 'admin')) return send(res, 404, { error: 'Team not found' }), true; if (!teamCan(user, 'team.invite', t)) return send(res, 403, { error: 'Only team owners can invite people' }), true;
      const role = body.role === undefined ? 'member' : body.role; if (!isTeamRole(role)) return send(res, 400, { error: 'Invalid role' }), true;
      const out = makeInvitation('team', t, role, body.username, 'team'); return send(res, out.status, out.body), true;
    }
    if (parts[1] === 'me' && parts[2] === 'invitations' && method === 'GET') return send(res, 200, { invitations: db.invitations.filter((i) => i.to === user.id && i.status === 'pending').map(invitationView), sent: db.invitations.filter((i) => i.from === user.id && i.status === 'pending').map((i) => ({ ...invitationView(i), to: card(userById(i.to)) })) }), true;
    if (parts[1] === 'invitations' && parts[2] && ['accept', 'decline'].includes(parts[3]) && method === 'POST') {
      const inv = db.invitations.find((i) => i.id === parts[2] && i.to === user.id && i.status === 'pending'); if (!inv) return send(res, 404, { error: 'Invitation not found' }), true;
      const target = inv.kind === 'workspace' ? project(inv.targetId) : team(inv.targetId); if (!target) { inv.status = 'expired'; save(); return send(res, 404, { error: 'This project no longer exists' }), true; }
      if (parts[3] === 'accept') { if (!target.members[user.id]) target.members[user.id] = inv.role; inv.status = 'accepted'; notify(inv.from, `@${user.username} accepted your invitation to "${target.name}"`, `invitation:${inv.id}`); } else { inv.status = 'declined'; notify(inv.from, `@${user.username} declined your invitation to "${target.name}"`, `invitation:${inv.id}`); }
      audit(user, `invitation.${parts[3]}`, inv.id); save(); return send(res, 200, { status: inv.status, kind: inv.kind, id: target.id, name: target.name }), true;
    }
    if (parts[1] === 'invitations' && parts[2] && parts.length === 3 && method === 'DELETE') {
      const inv = db.invitations.find((i) => i.id === parts[2] && i.from === user.id && i.status === 'pending'); if (!inv) return send(res, 404, { error: 'Invitation not found' }), true; inv.status = 'cancelled'; save(); return send(res, 200, { ok: true }), true;
    }
    return false;
  };
}
