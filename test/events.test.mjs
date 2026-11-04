import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../lib/app.mjs';
import { weightedTotal, leaderboard, csvEscape, replayEvents, stateAt, processSignals } from '../lib/judging.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
let app, base, dir;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hc-events-'));
  app = createApp({ root, stateFile: join(dir, 'state.json'), authLimit: 1000 });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

const person = async (name, email) => {
  let cookie = '';
  const call = async (method, path, body) => { const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]; const type = res.headers.get('content-type') || ''; return { status: res.status, type, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) }; };
  const r = await call('POST', '/api/auth/signup', { name, email, password: 'correct-horse-battery' }); assert.equal(r.status, 201); return { call, id: r.body.user.id, email };
};

test('judging helpers: weighted totals, CSV injection, replay, normalisation', () => {
  const rubric = [{ id: 'a', name: 'A', weight: 3, max: 10 }, { id: 'b', name: 'B', weight: 1, max: 10 }];
  assert.equal(weightedTotal(rubric, { a: 10, b: 0 }), 75); assert.equal(weightedTotal(rubric, { a: 5, b: 5 }), 50);
  assert.equal(csvEscape('=cmd|calc'), "'=cmd|calc"); assert.equal(csvEscape('a,"b"'), '"a,""b"""');
  const h = [{ path: 'a.js', content: 'x', actor: 'Ann', kind: 'file_created', createdAt: 1 }, { path: 'a.js', content: 'x'.repeat(900), actor: 'Ann', kind: 'edit', createdAt: 2 }, { path: 'b.js', content: 'y', actor: 'HackConnect Agent (for Bo)', kind: 'agent_edit', createdAt: 3 }];
  const ev = replayEvents(h); assert.equal(ev[1].paste, true); assert.equal(ev[2].actorKind, 'agent'); assert.deepEqual(Object.keys(stateAt(h, 1)), ['a.js']); assert.equal(processSignals(h, ['Ann', 'Bo']).agentAuthoredShare, 33);
  const event = { rubric, tiebreakCriterion: 'a' };
  const subs = [{ id: 's1', title: 'One', teamName: 'T1' }, { id: 's2', title: 'Two', teamName: 'T2' }];
  const scores = [{ submissionId: 's1', judgeId: 'harsh', scores: { a: 4, b: 4 } }, { submissionId: 's2', judgeId: 'harsh', scores: { a: 2, b: 2 } }, { submissionId: 's2', judgeId: 'kind', scores: { a: 10, b: 10 } }, { submissionId: 's1', judgeId: 'kind', scores: { a: 9, b: 9 } }];
  const board = leaderboard(event, subs, scores, 'normalized'); assert.equal(board.length, 2); assert.ok(board[0].normalized >= board[1].normalized);
});

test('full hackathon lifecycle', async () => {
  const org = await person('Olga Organizer', 'olga@x.io'); const judge1 = await person('Jules Judge', 'jules@x.io'); const judge2 = await person('Jan Judge', 'jan@x.io');
  const p1 = await person('Pia', 'pia@x.io'); const p2 = await person('Pat', 'pat@x.io'); const p3 = await person('Pru', 'pru@x.io'); const stranger = await person('Sam Stranger', 'sam@x.io');
  const ev = await org.call('POST', '/api/events', { title: 'Spring Hack', tracks: ['AI', 'Web'], maxTeamSize: 2, agentPolicy: 'declare', blind: true }); assert.equal(ev.status, 201); const id = ev.body.id;
  assert.equal(ev.body.rubric.length, 5);
  // drafts are invisible to non-members; only organizer can manage
  assert.equal((await stranger.call('GET', `/api/events/${id}`)).status, 404);
  assert.equal((await stranger.call('PATCH', `/api/events/${id}`, { status: 'registration' })).status, 404);
  assert.equal((await org.call('PATCH', `/api/events/${id}`, { status: 'registration' })).status, 200);
  assert.equal((await org.call('PATCH', `/api/events/${id}`, { status: 'draft' })).status, 400); // forward only
  for (const j of [judge1, judge2]) assert.equal((await org.call('POST', `/api/events/${id}/roles`, { email: j.email, role: 'judge' })).status, 200);
  assert.equal((await p1.call('POST', `/api/events/${id}/roles`, { email: p1.email, role: 'organizer' })).status, 403);
  assert.equal((await stranger.call('POST', `/api/events/${id}/roles`, { email: p1.email, role: 'organizer' })).status, 403);
  for (const p of [p1, p2, p3]) assert.equal((await p.call('POST', `/api/events/${id}/register`, {})).status, 200);
  assert.equal((await p1.call('POST', `/api/events/${id}/teams`, {})).status, 400);
  const t1 = await p1.call('POST', `/api/events/${id}/teams`, { name: 'Alpha' }); assert.equal(t1.status, 201);
  assert.equal((await p1.call('POST', `/api/events/${id}/teams`, { name: 'Dup' })).status, 409);
  assert.equal((await p2.call('POST', `/api/events/${id}/teams/${t1.body.id}/join`, {})).status, 200);
  assert.equal((await p3.call('POST', `/api/events/${id}/teams/${t1.body.id}/join`, {})).status, 409); // team size limit 2
  const t2 = await p3.call('POST', `/api/events/${id}/teams`, { name: 'Beta' }); assert.equal(t2.status, 201);
  assert.equal((await judge1.call('POST', `/api/events/${id}/teams`, { name: 'Sneaky' })).status, 403); // judges cannot form teams
  assert.equal((await org.call('PATCH', `/api/events/${id}`, { status: 'hacking' })).status, 200);

  // teams work in their auto-created workspaces; organizer dashboard sees activity
  const wsA = t1.body.workspaceId; const wsB = t2.body.workspaceId;
  assert.equal((await p2.call('PUT', `/api/projects/${wsA}/files`, { path: 'index.js', content: 'console.log("alpha")' })).status, 200);
  assert.equal((await p1.call('PUT', `/api/projects/${wsA}/files`, { path: 'big.js', content: 'z'.repeat(800) })).status, 200);
  assert.equal((await p3.call('PUT', `/api/projects/${wsB}/files`, { path: 'index.py', content: 'print("beta")' })).status, 200);
  assert.equal((await p3.call('GET', `/api/projects/${wsA}`)).status, 404); // other team's workspace stays private
  await new Promise((r) => setTimeout(r, 50));
  const dash = await org.call('GET', `/api/events/${id}/dashboard`); assert.equal(dash.status, 200); assert.equal(dash.body.teams.length, 2); assert.ok(dash.body.teams.find((t) => t.team === 'Alpha').edits >= 3);
  assert.equal((await p1.call('GET', `/api/events/${id}/dashboard`)).status, 403);
  assert.equal((await p1.call('POST', `/api/events/${id}/announcements`, { text: 'hi' })).status, 403);
  assert.equal((await org.call('POST', `/api/events/${id}/announcements`, { text: 'Lunch at noon' })).status, 201);
  assert.ok((await p1.call('GET', '/api/notifications')).body.notifications.some((n) => n.text.includes('Lunch')));
  const mr = await p1.call('POST', `/api/events/${id}/mentor-requests`, { topic: 'Stuck on CORS' }); assert.equal(mr.status, 201);
  assert.equal((await p1.call('GET', `/api/events/${id}/mentor-requests`)).status, 403); assert.equal((await org.call('GET', `/api/events/${id}/mentor-requests`)).body.requests.length, 1);

  // submissions: agent declaration required by policy, urls sanitised, outsiders refused
  assert.equal((await p1.call('PUT', `/api/events/${id}/submission`, { title: 'Alpha App' })).status, 400);
  assert.equal((await stranger.call('PUT', `/api/events/${id}/submission`, { title: 'x', agentUsage: 'none' })).status, 403);
  const s1 = await p1.call('PUT', `/api/events/${id}/submission`, { title: 'Alpha App', summary: 'Does things', track: 'AI', agentUsage: 'none', demoUrl: 'javascript:alert(1)', repoUrl: 'https://github.com/a/b', tech: ['node'] }); assert.equal(s1.status, 200); assert.equal(s1.body.demoUrl, ''); assert.equal(s1.body.repoUrl, 'https://github.com/a/b');
  assert.equal((await p3.call('PUT', `/api/events/${id}/submission`, { title: 'Beta App', agentUsage: 'Used Claude for tests', track: 'Web' })).status, 200);
  assert.equal((await judge1.call('GET', `/api/events/${id}/submissions`)).status, 409); // judging not started

  // deadline: judging phase freezes workspaces with a final snapshot
  assert.equal((await org.call('PATCH', `/api/events/${id}`, { status: 'judging' })).status, 200);
  assert.equal((await p1.call('PUT', `/api/projects/${wsA}/files`, { path: 'late.js', content: 'too late' })).status, 403);
  assert.equal((await p1.call('PUT', `/api/events/${id}/submission`, { title: 'Late', agentUsage: 'none' })).status, 409);
  assert.equal((await p1.call('POST', `/api/projects/${wsA}/agent`, { prompt: 'x' })).status, 403);
  assert.ok(app.db.snapshots[wsA].tag.startsWith('final-'));
  assert.equal((await org.call('POST', `/api/events/${id}/unfreeze`, {})).status, 200); assert.equal((await p1.call('PUT', `/api/projects/${wsA}/files`, { path: 'ok.js', content: 'override' })).status, 200);
  await org.call('PATCH', `/api/events/${id}`, { status: 'judging' }); // already judging: no-op
  const frozenAgain = app.db.projects.find((p) => p.id === wsA); frozenAgain.frozen = true; // organizer re-freezes via data for the remainder of the test

  // judges: blind mode hides identities; participants cannot see submissions
  assert.equal((await p1.call('GET', `/api/events/${id}/submissions`)).status, 403);
  const list = await judge1.call('GET', `/api/events/${id}/submissions`); assert.equal(list.body.submissions.length, 2); assert.ok(list.body.submissions.every((s) => /^Submission \d/.test(s.teamName)));
  const sid = list.body.submissions[0].id; const detail = await judge1.call('GET', `/api/events/${id}/submissions/${sid}`);
  assert.equal(detail.body.teamName, null); assert.deepEqual(detail.body.members, []); assert.ok(detail.body.fileTree.length >= 1); assert.ok(detail.body.languages.length >= 1);
  assert.ok(detail.body.signals.contributionByMember.every((m) => /^Member/.test(m.name)));
  const alphaSub = (await org.call('GET', `/api/events/${id}/submissions`)).body.submissions.find((s) => s.teamName === 'Alpha');
  const replay = await judge1.call('GET', `/api/events/${id}/submissions/${alphaSub.id}/replay`); assert.ok(replay.body.total >= 3); assert.ok(replay.body.events.some((x) => x.paste), 'large paste is marked');
  const st = await judge1.call('GET', `/api/events/${id}/submissions/${alphaSub.id}/replay/state?index=0`); assert.deepEqual(Object.keys(st.body.files), ['README.md']);
  // scoring validation + COI + permissions
  const rubric = ev.body.rubric; const full = Object.fromEntries(rubric.map((c) => [c.id, c.max]));
  assert.equal((await judge1.call('POST', `/api/events/${id}/submissions/${alphaSub.id}/scores`, { scores: { [rubric[0].id]: 99 } })).status, 400);
  assert.equal((await org.call('POST', `/api/events/${id}/submissions/${alphaSub.id}/scores`, { scores: full })).status, 403);
  assert.equal((await judge1.call('POST', `/api/events/${id}/submissions/${alphaSub.id}/scores`, { scores: full, comments: 'great' })).body.total, 100);
  const betaSub = (await org.call('GET', `/api/events/${id}/submissions`)).body.submissions.find((s) => s.teamName === 'Beta');
  const half = Object.fromEntries(rubric.map((c) => [c.id, c.max / 2]));
  assert.equal((await judge1.call('POST', `/api/events/${id}/submissions/${betaSub.id}/scores`, { scores: half })).body.total, 50);
  assert.equal((await judge2.call('POST', `/api/events/${id}/submissions/${betaSub.id}/scores`, { scores: full })).status, 200);
  // assignment limits a judge's view
  await org.call('POST', `/api/events/${id}/assignments`, { judgeId: judge2.id, submissionIds: [betaSub.id] });
  assert.equal((await judge2.call('GET', `/api/events/${id}/submissions`)).body.submissions.length, 1);
  assert.equal((await judge2.call('GET', `/api/events/${id}/submissions/${alphaSub.id}`)).status, 404);
  // leaderboard hidden from judges until published; organizer sees it
  assert.equal((await judge1.call('GET', `/api/events/${id}/leaderboard`)).status, 403);
  const lb = await org.call('GET', `/api/events/${id}/leaderboard`); assert.equal(lb.body.rows[0].team, 'Alpha'); assert.equal(lb.body.rows[0].rank, 1);
  assert.equal((await org.call('GET', `/api/events/${id}/leaderboard?mode=normalized`)).status, 200);
  const csv = await org.call('GET', `/api/events/${id}/export`); assert.match(csv.type, /text\/csv/); assert.match(csv.body.toString(), /^rank,team,title/);
  assert.equal((await judge1.call('GET', `/api/events/${id}/export`)).status, 403);
  // results: public gallery and certificate
  assert.equal((await p1.call('GET', `/api/events/${id}/certificate/${t1.body.id}`)).status, 409);
  await org.call('PATCH', `/api/events/${id}`, { status: 'results' });
  assert.equal((await p1.call('GET', `/api/events/${id}/leaderboard`)).status, 200); // published results are public to participants
  assert.equal((await p1.call('GET', `/api/events/${id}/submissions`)).status, 403); // but judge detail views stay closed
  const pdf = await p1.call('GET', `/api/events/${id}/certificate/${t1.body.id}`); assert.equal(pdf.status, 200); assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-'); assert.equal((await p3.call('GET', `/api/events/${id}/certificate/${t1.body.id}`)).status, 403);
  const gallery = await stranger.call('GET', '/api/gallery'); assert.ok(gallery.body.items.some((x) => x.title === 'Alpha App' && x.teamName === 'Alpha'));
});
