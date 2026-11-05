// Hackathon hosting + submissions + judging routes. Returns true when a request was handled.
import crypto from 'node:crypto';
import { eventCan, eventRole, isEventRole } from './policy.mjs';
import { languageStats, dependencies, replayEvents, stateAt, processSignals, validateScores, weightedTotal, leaderboard, csvEscape, certificatePdf } from './judging.mjs';

export const STATUSES = ['draft', 'registration', 'hacking', 'submission', 'judging', 'results'];
const AGENT_POLICIES = ['allowed', 'declare', 'none'];
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const url = (v) => { const s = str(v, 500); return /^https?:\/\//i.test(s) ? s : ''; };

export function createEvents({ db, json, fail, audit, activity, collab, save, recordHistory, notify }) {
  db.events ||= []; db.snapshots ||= {};
  const find = (id) => db.events.find((e) => e.id === id);
  const userById = (id) => db.users.find((u) => u.id === id);
  const publicEvent = (e, user) => ({ id: e.id, title: e.title, description: e.description, rules: e.rules, tracks: e.tracks, status: e.status, agentPolicy: e.agentPolicy, maxTeamSize: e.maxTeamSize, rubric: e.rubric, blind: e.blind, leaderboardVisible: e.leaderboardVisible, deadline: e.deadline, role: eventRole(e, user), announcements: e.announcements.slice(-20), teams: e.teams.map((t) => ({ id: t.id, name: t.name, size: t.members.length })), registered: e.registrations.length });
  const teamOf = (e, user) => e.teams.find((t) => t.members.includes(user.id));
  const needRole = (user, e, action) => { if (!e || (eventRole(e, user) === null && e.status === 'draft')) throw fail(404, 'Event not found'); if (action === 'event.read') return; if (!eventCan(user, action, e)) throw fail(403, 'You do not have permission to do that'); };

  function freeze(e, actor) {
    collab.flush();
    for (const t of e.teams) {
      const p = db.projects.find((x) => x.id === t.workspaceId); if (!p || p.frozen) continue;
      p.frozen = true; db.snapshots[p.id] = { tag: `final-${e.id.slice(0, 8)}`, at: Date.now(), files: { ...p.files }, historyLength: (db.history[p.id] || []).length };
      activity({ name: 'HackConnect', initials: 'HC' }, 'froze workspace', p.name, `Final snapshot ${db.snapshots[p.id].tag} created at the deadline`, p.id);
    }
    audit(actor, 'event.freeze', e.id);
  }
  function unfreeze(e, actor) { for (const t of e.teams) { const p = db.projects.find((x) => x.id === t.workspaceId); if (p) p.frozen = false; } audit(actor, 'event.unfreeze', e.id); }

  const submissionView = (e, sub, { reveal, withFiles }) => {
    const team = e.teams.find((t) => t.id === sub.teamId); const snap = db.snapshots[team.workspaceId]; const files = snap?.files || db.projects.find((p) => p.id === team.workspaceId)?.files || {};
    const history = db.history[team.workspaceId] || [];
    const names = team.members.map((id) => userById(id)?.name).filter(Boolean);
    const view = { id: sub.id, title: sub.title, summary: sub.summary, track: sub.track, demoUrl: sub.demoUrl, repoUrl: sub.repoUrl, deployedUrl: sub.deployedUrl, tech: sub.tech, agentUsageDeclared: sub.agentUsage, teamName: reveal ? team.name : null, members: reveal ? names : [], snapshotTag: snap?.tag || null, frozen: Boolean(snap), languages: languageStats(files), fileTree: Object.keys(files).sort(), dependencies: dependencies(files), signals: processSignals(history.slice(0, snap?.historyLength ?? history.length), reveal ? names : []) };
    if (!reveal) view.signals.contributionByMember = view.signals.contributionByMember.map((m, i) => ({ name: `Member ${i + 1}`, edits: m.edits }));
    if (withFiles) view.files = files;
    return view;
  };
  const isJudgeFor = (e, user, sub) => { const a = e.assignments?.[user.id]; return !a || a.includes(sub.id); };
  const blindFor = (e, user) => e.blind && eventRole(e, user) === 'judge';

  /** Called every 30 s (and by tests): warns 15 minutes before a deadline, then moves the event to judging and freezes workspaces. */
  function tick(now = Date.now()) {
    for (const e of db.events) {
      if (!e.deadline || !['hacking', 'submission'].includes(e.status)) continue;
      if (now >= e.deadline) { freeze(e, null); e.status = 'judging'; audit(null, 'event.auto_deadline', e.id, new Date(e.deadline).toISOString()); for (const id of Object.keys(e.members)) notify(id, `${e.title}: the deadline has passed. Workspaces are frozen and judging has started.`, e.id); save(); }
      else {
        const left = e.deadline - now; e.stages ||= []; let hit = null;
        for (const [ms, label] of [[72 * 3600e3, '3 days'], [24 * 3600e3, '24 hours'], [3 * 3600e3, '3 hours'], [3600e3, '1 hour'], [15 * 60e3, '15 minutes']]) if (left <= ms) hit = [ms, label];
        if (hit && !e.stages.includes(hit[0])) {
          for (const ms of [72 * 3600e3, 24 * 3600e3, 3 * 3600e3, 3600e3, 15 * 60e3]) if (ms >= hit[0] && !e.stages.includes(ms)) e.stages.push(ms);
          if (hit[0] === 15 * 60e3) e.warned = true;
          for (const id of Object.keys(e.members)) notify(id, `${e.title}: ${hit[1]} until the deadline.${hit[0] <= 3600e3 ? ' Submit now!' : ' Make sure your submission is on track.'}`, { type: 'event', id: e.id, kind: 'deadline', at: e.deadline });
          save();
        }
      }
    }
  }

  const handle = async function ({ req, res, user, parts, body }) {
    if (parts[1] === 'gallery' && req.method === 'GET') {
      const items = db.events.filter((e) => e.status === 'results').flatMap((e) => e.submissions.map((s) => ({ event: e.title, eventId: e.id, ...submissionView(e, s, { reveal: true, withFiles: false }) })));
      return json(res, 200, { items: items.map(({ files, signals, ...rest }) => rest) }), true;
    }
    if (parts[1] === 'notifications') {
      if (req.method === 'GET') return json(res, 200, { notifications: db.notifications.filter((n) => n.userId === user.id).slice(-50).reverse() }), true;
      if (req.method === 'POST') { for (const n of db.notifications) if (n.userId === user.id) n.read = true; save(); return json(res, 200, { ok: true }), true; }
    }
    if (parts[1] !== 'events') return false;
    const mutating = req.method !== 'GET';

    if (parts.length === 2 && req.method === 'GET') return json(res, 200, { events: db.events.filter((e) => e.status !== 'draft' || eventRole(e, user)).map((e) => publicEvent(e, user)) }), true;
    if (parts.length === 2 && req.method === 'POST') {
      const title = str(body.title, 120); if (!title) return json(res, 400, { error: 'Event title is required' }), true;
      const maxTeamSize = Math.min(10, Math.max(1, Number(body.maxTeamSize) || 4)); const agentPolicy = body.agentPolicy === undefined ? 'declare' : body.agentPolicy; if (!AGENT_POLICIES.includes(agentPolicy)) return json(res, 400, { error: 'Invalid agent policy' }), true;
      const tracks = (Array.isArray(body.tracks) ? body.tracks : ['General']).map((t) => str(t, 60)).filter(Boolean).slice(0, 10);
      const rubric = (Array.isArray(body.rubric) && body.rubric.length ? body.rubric : [{ name: 'Innovation', weight: 3 }, { name: 'Execution', weight: 3 }, { name: 'Impact', weight: 2 }, { name: 'Build process', weight: 1 }, { name: 'Collaboration', weight: 1 }]).slice(0, 12).map((c) => ({ id: crypto.randomUUID(), name: str(c.name, 60), weight: Math.min(100, Math.max(0.1, Number(c.weight) || 1)), max: Math.min(100, Math.max(1, Number(c.max) || 10)) })).filter((c) => c.name);
      const e = { id: crypto.randomUUID(), title, description: str(body.description, 4000), rules: str(body.rules, 4000), tracks, status: 'draft', agentPolicy, maxTeamSize, rubric, blind: Boolean(body.blind), leaderboardVisible: false, tiebreakCriterion: rubric[0]?.id || null, deadline: Number(body.deadline) || null, members: { [user.id]: 'organizer' }, registrations: [], teams: [], announcements: [], mentorRequests: [], submissions: [], scores: [], assignments: {}, createdAt: Date.now() };
      db.events.push(e); audit(user, 'event.create', e.id, title); save(); return json(res, 201, publicEvent(e, user)), true;
    }
    const e = find(parts[2]); needRole(user, e, 'event.read'); const sub = parts[3];
    if (parts.length === 3 && req.method === 'GET') return json(res, 200, publicEvent(e, user)), true;
    if (parts.length === 3 && req.method === 'PATCH') {
      needRole(user, e, 'event.manage');
      if (body.status !== undefined) {
        const from = STATUSES.indexOf(e.status); const to = STATUSES.indexOf(body.status); if (to < 0 || to < from) return json(res, 400, { error: 'Status can only move forward' }), true;
        if (to >= STATUSES.indexOf('judging') && from < STATUSES.indexOf('judging')) freeze(e, user);
        e.status = body.status; audit(user, 'event.status', e.id, e.status);
        for (const id of Object.keys(e.members)) notify(id, `${e.title} is now in the "${e.status}" phase`, e.id);
      }
      for (const k of ['title', 'description', 'rules']) if (body[k] !== undefined) e[k] = str(body[k], k === 'title' ? 120 : 4000);
      if (body.blind !== undefined) e.blind = Boolean(body.blind); if (body.leaderboardVisible !== undefined) e.leaderboardVisible = Boolean(body.leaderboardVisible);
      if (body.deadline !== undefined) { e.deadline = Number(body.deadline) || null; e.warned = false; e.stages = []; } if (body.agentPolicy !== undefined && AGENT_POLICIES.includes(body.agentPolicy)) e.agentPolicy = body.agentPolicy;
      if (body.tiebreakCriterion !== undefined && e.rubric.some((c) => c.id === body.tiebreakCriterion)) e.tiebreakCriterion = body.tiebreakCriterion;
      save(); return json(res, 200, publicEvent(e, user)), true;
    }
    if (sub === 'freeze' && req.method === 'POST') { needRole(user, e, 'event.manage'); freeze(e, user); save(); return json(res, 200, { ok: true }), true; }
    if (sub === 'unfreeze' && req.method === 'POST') { needRole(user, e, 'event.manage'); unfreeze(e, user); save(); return json(res, 200, { ok: true }), true; }
    if (sub === 'register' && req.method === 'POST') {
      if (!['registration', 'hacking'].includes(e.status)) return json(res, 409, { error: 'Registration is not open' }), true;
      if (!e.members[user.id]) e.members[user.id] = 'participant'; if (!e.registrations.some((r) => r.userId === user.id)) e.registrations.push({ userId: user.id, at: Date.now(), checkedIn: false });
      audit(user, 'event.register', e.id); save(); return json(res, 200, publicEvent(e, user)), true;
    }
    if (sub === 'roles' && req.method === 'POST') {
      needRole(user, e, 'event.manage'); const target = db.users.find((u) => u.email === str(body.email, 254).toLowerCase()); if (!target) return json(res, 404, { error: 'No account with that email yet' }), true;
      if (!isEventRole(body.role)) return json(res, 400, { error: 'Invalid role' }), true;
      if (e.members[target.id] === 'organizer' && body.role !== 'organizer' && Object.values(e.members).filter((r) => r === 'organizer').length === 1) return json(res, 409, { error: 'An event needs at least one organizer' }), true;
      e.members[target.id] = body.role; notify(target.id, `You were added to ${e.title} as ${body.role}`, e.id); audit(user, 'event.role', e.id, `${target.id}:${body.role}`); save(); return json(res, 200, { id: target.id, role: body.role }), true;
    }
    if (sub === 'checkin' && req.method === 'POST') { needRole(user, e, 'event.manage'); const r = e.registrations.find((x) => x.userId === body.userId); if (!r) return json(res, 404, { error: 'Not registered' }), true; r.checkedIn = true; save(); return json(res, 200, { ok: true }), true; }
    if (sub === 'announcements' && req.method === 'POST') {
      needRole(user, e, 'event.announce'); const text = str(body.text, 1000); if (!text) return json(res, 400, { error: 'Announcement text is required' }), true;
      e.announcements.push({ id: crypto.randomUUID(), text, by: user.name, at: Date.now() }); for (const id of Object.keys(e.members)) notify(id, `📣 ${e.title}: ${text}`, e.id); save(); return json(res, 201, { ok: true }), true;
    }
    if (sub === 'mentor-requests') {
      if (req.method === 'POST') { if (!teamOf(e, user)) return json(res, 409, { error: 'Join a team first' }), true; const r = { id: crypto.randomUUID(), teamId: teamOf(e, user).id, topic: str(body.topic, 300), status: 'open', at: Date.now() }; if (!r.topic) return json(res, 400, { error: 'Describe what you need help with' }), true; e.mentorRequests.push(r); for (const [id, role] of Object.entries(e.members)) if (role === 'mentor' || role === 'organizer') notify(id, `Mentor request: ${r.topic}`, e.id); save(); return json(res, 201, r), true; }
      if (req.method === 'GET') { needRole(user, e, 'event.mentor'); return json(res, 200, { requests: e.mentorRequests.map((r) => ({ ...r, team: e.teams.find((t) => t.id === r.teamId)?.name })) }), true; }
      if (req.method === 'PATCH') { needRole(user, e, 'event.mentor'); const r = e.mentorRequests.find((x) => x.id === parts[4]); if (!r) return json(res, 404, { error: 'Request not found' }), true; r.status = 'resolved'; save(); return json(res, 200, r), true; }
    }
    // ---- teams (each team gets a workspace)
    if (sub === 'teams' && req.method === 'POST' && !parts[4]) {
      if (eventRole(e, user) !== 'participant') return json(res, 403, { error: 'Register for the event first' }), true;
      if (!['registration', 'hacking'].includes(e.status)) return json(res, 409, { error: 'Team formation is closed' }), true; if (teamOf(e, user)) return json(res, 409, { error: 'You are already on a team' }), true;
      const name = str(body.name, 60); if (!name) return json(res, 400, { error: 'Team name is required' }), true;
      const wsId = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'team'}-${Date.now().toString(36)}`;
      const ws = { id: wsId, name: `${name} — ${e.title}`.slice(0, 80), description: `Workspace for ${e.title}`, createdAt: Date.now(), teamId: null, eventId: e.id, members: { [user.id]: 'owner' }, legacy: false, files: { 'README.md': `# ${name}\n\nBuilding for ${e.title}.\n` } };
      db.projects.unshift(ws); db.messages[ws.id] = []; db.history[ws.id] = []; recordHistory(ws, 'README.md', ws.files['README.md'], user.name, 'file_created');
      const t = { id: crypto.randomUUID(), name, members: [user.id], workspaceId: ws.id, inviteHash: null }; e.teams.push(t); audit(user, 'event.team', e.id, name); save();
      return json(res, 201, { id: t.id, name, workspaceId: ws.id }), true;
    }
    if (sub === 'teams' && parts[4] && parts[5] === 'join' && req.method === 'POST') {
      const t = e.teams.find((x) => x.id === parts[4]); if (!t) return json(res, 404, { error: 'Team not found' }), true;
      if (eventRole(e, user) !== 'participant') return json(res, 403, { error: 'Register for the event first' }), true; if (teamOf(e, user)) return json(res, 409, { error: 'You are already on a team' }), true;
      if (e.status !== 'registration' && e.status !== 'hacking') return json(res, 409, { error: 'Team formation is closed' }), true; if (t.members.length >= e.maxTeamSize) return json(res, 409, { error: `Teams are limited to ${e.maxTeamSize} people` }), true;
      t.members.push(user.id); db.projects.find((p) => p.id === t.workspaceId).members[user.id] = 'editor'; save(); return json(res, 200, { workspaceId: t.workspaceId }), true;
    }
    if (sub === 'mine' && req.method === 'GET') { const t = teamOf(e, user); return json(res, 200, { team: t ? { id: t.id, name: t.name, workspaceId: t.workspaceId, submission: e.submissions.find((s) => s.teamId === t.id) || null } : null }), true; }
    // ---- live organizer dashboard
    if (sub === 'dashboard' && req.method === 'GET') {
      needRole(user, e, 'event.dashboard'); const now = Date.now();
      const rows = e.teams.map((t) => { const p = db.projects.find((x) => x.id === t.workspaceId); const h = db.history[p.id] || []; const signals = processSignals(h); const last = h.length ? h[h.length - 1].createdAt : null; return { teamId: t.id, team: t.name, members: t.members.length, files: Object.keys(p.files).length, lines: Object.values(p.files).reduce((a, c) => a + c.split('\n').length, 0), edits: h.length, lastActivity: last, idleMinutes: last ? Math.round((now - last) / 60000) : null, agentShare: signals.agentAuthoredShare, balance: signals.contributionBalance, frozen: Boolean(p.frozen), submitted: e.submissions.some((s) => s.teamId === t.id), stuck: e.status === 'hacking' && (!last || now - last > 90 * 60000) }; });
      return json(res, 200, { status: e.status, registered: e.registrations.length, checkedIn: e.registrations.filter((r) => r.checkedIn).length, openMentorRequests: e.mentorRequests.filter((r) => r.status === 'open').length, teams: rows, alerts: rows.filter((r) => r.stuck).map((r) => `${r.team} has been inactive for 90+ minutes`) }), true;
    }
    // ---- submissions (team side)
    if (sub === 'submission' && req.method === 'PUT') {
      const t = teamOf(e, user); if (!t) return json(res, 403, { error: 'Only team members can submit' }), true; if (!['hacking', 'submission'].includes(e.status)) return json(res, 409, { error: 'Submissions are not open' }), true;
      const title = str(body.title, 120); if (!title) return json(res, 400, { error: 'Submission title is required' }), true;
      const track = str(body.track, 60) || e.tracks[0]; if (!e.tracks.includes(track)) return json(res, 400, { error: 'Unknown track' }), true;
      const agentUsage = str(body.agentUsage, 500); if (e.agentPolicy === 'declare' && !agentUsage) return json(res, 400, { error: 'This event requires you to declare agent usage (write "none" if you used no agents)' }), true;
      let s = e.submissions.find((x) => x.teamId === t.id); if (!s) { s = { id: crypto.randomUUID(), teamId: t.id, createdAt: Date.now() }; e.submissions.push(s); }
      Object.assign(s, { title, summary: str(body.summary, 2000), track, demoUrl: url(body.demoUrl), repoUrl: url(body.repoUrl), deployedUrl: url(body.deployedUrl), tech: (Array.isArray(body.tech) ? body.tech : []).map((x) => str(x, 40)).filter(Boolean).slice(0, 20), agentUsage, updatedAt: Date.now() });
      audit(user, 'submission.save', e.id, s.id); save(); return json(res, 200, s), true;
    }
    // ---- judging
    if (sub === 'assignments' && req.method === 'POST') {
      needRole(user, e, 'event.manage'); if (e.members[body.judgeId] !== 'judge') return json(res, 400, { error: 'Not a judge in this event' }), true;
      const ids = (Array.isArray(body.submissionIds) ? body.submissionIds : []).filter((id) => e.submissions.some((s) => s.id === id)); e.assignments[body.judgeId] = ids; notify(body.judgeId, `You were assigned ${ids.length} submissions in ${e.title}`, e.id); save(); return json(res, 200, { assigned: ids.length }), true;
    }
    if (sub === 'submissions') {
      const role = eventRole(e, user); if (!['judge', 'organizer'].includes(role)) throw fail(403, 'Only judges and organizers can view submissions');
      if (STATUSES.indexOf(e.status) < STATUSES.indexOf('judging')) return json(res, 409, { error: 'Judging has not started' }), true;
      const reveal = !blindFor(e, user);
      if (parts.length === 4 && req.method === 'GET') return json(res, 200, { submissions: e.submissions.filter((s) => role === 'organizer' || isJudgeFor(e, user, s)).map((s, i) => { const v = submissionView(e, s, { reveal, withFiles: false }); return { id: s.id, title: v.title, track: v.track, teamName: reveal ? v.teamName : `Submission ${i + 1}`, scored: e.scores.some((x) => x.submissionId === s.id && x.judgeId === user.id) }; }) }), true;
      const s = e.submissions.find((x) => x.id === parts[4]); if (!s || (role === 'judge' && !isJudgeFor(e, user, s))) return json(res, 404, { error: 'Submission not found' }), true;
      const team = e.teams.find((t) => t.id === s.teamId); const history = db.history[team.workspaceId] || []; const limit = db.snapshots[team.workspaceId]?.historyLength ?? history.length;
      if (parts.length === 5 && req.method === 'GET') return json(res, 200, { ...submissionView(e, s, { reveal, withFiles: true }), myScore: e.scores.find((x) => x.submissionId === s.id && x.judgeId === user.id) || null }), true;
      if (parts[5] === 'replay' && req.method === 'GET') { const slice = history.slice(0, limit); const events = replayEvents(slice).map((ev) => reveal ? ev : { ...ev, actor: ev.actorKind === 'agent' ? 'Agent' : 'Member' }); if (parts[6] === 'state') { const i = Math.min(Math.max(0, Number(new URL(req.url, 'http://x').searchParams.get('index'))), Math.max(0, slice.length - 1)); return json(res, 200, { index: i, files: stateAt(slice, i) }), true; } return json(res, 200, { total: events.length, events }), true; }
      if (parts[5] === 'scores' && req.method === 'POST') {
        if (role !== 'judge') return json(res, 403, { error: 'Only judges can score' }), true;
        if (team.members.includes(user.id)) return json(res, 403, { error: 'Conflict of interest: you are on this team' }), true;
        if (e.status !== 'judging') return json(res, 409, { error: 'Scoring is closed' }), true;
        const problem = validateScores(e.rubric, body.scores); if (problem) return json(res, 400, { error: problem }), true;
        let row = e.scores.find((x) => x.submissionId === s.id && x.judgeId === user.id); if (!row) { row = { submissionId: s.id, judgeId: user.id }; e.scores.push(row); }
        row.scores = Object.fromEntries(e.rubric.map((c) => [c.id, body.scores[c.id]])); row.comments = str(body.comments, 2000); row.at = Date.now(); audit(user, 'score.save', e.id, s.id); save();
        return json(res, 200, { total: weightedTotal(e.rubric, row.scores) }), true;
      }
    }
    if (sub === 'leaderboard' && req.method === 'GET') {
      const role = eventRole(e, user); const visible = role === 'organizer' || e.status === 'results' || (e.leaderboardVisible && role === 'judge'); if (!visible) return json(res, 403, { error: 'The leaderboard is hidden' }), true;
      const subs = e.submissions.map((s) => ({ id: s.id, title: s.title, teamName: e.teams.find((t) => t.id === s.teamId).name })); const mode = new URL(req.url, 'http://x').searchParams.get('mode') === 'normalized' ? 'normalized' : 'raw';
      return json(res, 200, { mode, rows: leaderboard(e, subs, e.scores, mode) }), true;
    }
    if (sub === 'export' && req.method === 'GET') {
      needRole(user, e, 'event.manage'); const fmt = new URL(req.url, 'http://x').searchParams.get('format') === 'json' ? 'json' : 'csv';
      const subs = e.submissions.map((s) => ({ id: s.id, title: s.title, teamName: e.teams.find((t) => t.id === s.teamId).name })); const rows = leaderboard(e, subs, e.scores, 'raw');
      if (fmt === 'json') return json(res, 200, { event: e.title, rubric: e.rubric, rows, scores: e.scores }), true;
      const head = ['rank', 'team', 'title', 'judges', 'raw_score', 'normalized_score', ...e.rubric.map((c) => `avg_${c.name}`)];
      const lines = [head.map(csvEscape).join(',')].concat(rows.map((r) => { const mine = e.scores.filter((x) => x.submissionId === r.submissionId); return [r.rank, r.team, r.title, r.judges, r.raw, r.normalized, ...e.rubric.map((c) => mine.length ? Math.round((mine.reduce((a, x) => a + x.scores[c.id], 0) / mine.length) * 100) / 100 : '')].map(csvEscape).join(','); }));
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="results-${e.id.slice(0, 8)}.csv"`, 'cache-control': 'no-store' }); res.end(lines.join('\n')); return true;
    }
    if (sub === 'certificate' && parts[4] && req.method === 'GET') {
      if (e.status !== 'results') return json(res, 409, { error: 'Certificates are available once results are published' }), true;
      const t = e.teams.find((x) => x.id === parts[4]); if (!t) return json(res, 404, { error: 'Team not found' }), true; if (!t.members.includes(user.id) && eventRole(e, user) !== 'organizer') return json(res, 403, { error: 'Not your team' }), true;
      const subs = e.submissions.map((s) => ({ id: s.id, title: s.title, teamName: e.teams.find((x) => x.id === s.teamId).name })); const row = leaderboard(e, subs, e.scores).find((r) => r.team === t.name);
      const pdf = certificatePdf({ eventTitle: e.title, teamName: t.name, rank: row?.judges ? row.rank : null, members: t.members.map((id) => userById(id)?.name).filter(Boolean) });
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="certificate-${t.name.replace(/[^a-z0-9]+/gi, '-')}.pdf"` }); res.end(pdf); return true;
    }
    return false;
  };
  handle.tick = tick;
  return handle;
}
