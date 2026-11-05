// Creates a demo hackathon: 3 teams, ~36h of edit history, 2 judges, a rubric, submissions, in "judging" state.
//   node scripts/seed.mjs            (refuses to touch a state file that already has users)
//   node scripts/seed.mjs --force    (DELETES existing state first)
// Stop the server before seeding: the app keeps state in memory and would overwrite the seed.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../lib/app.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)); const stateFile = process.env.HACKCONNECT_STATE || join(root, '.hackconnect', 'state.json');
if (existsSync(stateFile)) {
  const users = JSON.parse(readFileSync(stateFile, 'utf8')).users || [];
  if (users.length && !process.argv.includes('--force')) { console.error(`${stateFile} already has ${users.length} user(s). Re-run with --force to delete it first.`); process.exit(1); }
  if (process.argv.includes('--force')) rmSync(stateFile);
}
const PASSWORD = 'demo-password-123';
const app = createApp({ root, stateFile, authLimit: 100000 });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${app.server.address().port}`;

async function person(name, email) {
  let cookie = ''; const call = async (method, path, body) => { const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]; const json = await res.json().catch(() => ({})); if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${json.error}`); return json; };
  const out = await call('POST', '/api/auth/signup', { name, email, password: PASSWORD }); return { call, id: out.user.id, name, email };
}
try {
  const org = await person('Olivia Organizer', 'organizer@demo.hackconnect.dev'); const j1 = await person('Jamal Judge', 'judge1@demo.hackconnect.dev'); const j2 = await person('Jun Judge', 'judge2@demo.hackconnect.dev');
  const people = [await person('Maya Shah', 'maya@demo.hackconnect.dev'), await person('Arjun Kumar', 'arjun@demo.hackconnect.dev'), await person('Jia Rao', 'jia@demo.hackconnect.dev'), await person('Lena Fischer', 'lena@demo.hackconnect.dev'), await person('Omar Haddad', 'omar@demo.hackconnect.dev'), await person('Priya Nair', 'priya@demo.hackconnect.dev')];
  const ev = await org.call('POST', '/api/events', { title: 'Build for Good 2026', description: 'A weekend to build technology that makes an everyday difference.', rules: 'Teams of up to 3. Declare any AI agent usage.', tracks: ['Climate', 'Health', 'Education'], maxTeamSize: 3, agentPolicy: 'declare', blind: false, rubric: [{ name: 'Impact', weight: 3, max: 10 }, { name: 'Execution', weight: 3, max: 10 }, { name: 'Innovation', weight: 2, max: 10 }, { name: 'Build process', weight: 1, max: 10 }, { name: 'Collaboration', weight: 1, max: 10 }] });
  await org.call('PATCH', `/api/events/${ev.id}`, { status: 'registration' });
  await org.call('POST', `/api/events/${ev.id}/roles`, { email: j1.email, role: 'judge' }); await org.call('POST', `/api/events/${ev.id}/roles`, { email: j2.email, role: 'judge' });
  for (const p of people) await p.call('POST', `/api/events/${ev.id}/register`, {});
  const specs = [
    { name: 'GreenRoute', members: [0, 1], track: 'Climate', title: 'GreenRoute', summary: 'Plans lower-carbon commutes across bus, bike and rail.', agent: 'none' },
    { name: 'CareCircle', members: [2, 3], track: 'Health', title: 'CareCircle', summary: 'A support network for family caregivers.', agent: 'Used Claude Code to scaffold the API; all UI written by hand.' },
    { name: 'LearnLoop', members: [4, 5], track: 'Education', title: 'LearnLoop', summary: 'Spaced-repetition flashcards from your own notes.', agent: 'none' }
  ];
  await org.call('PATCH', `/api/events/${ev.id}`, { status: 'hacking' });
  const teams = [];
  for (const s of specs) {
    const lead = people[s.members[0]]; const team = await lead.call('POST', `/api/events/${ev.id}/teams`, { name: s.name });
    for (const m of s.members.slice(1)) await people[m].call('POST', `/api/events/${ev.id}/teams/${team.id}/join`, {});
    teams.push({ ...s, id: team.id, workspaceId: team.workspaceId });
  }
  // Build a believable history: many small edits by each member, one large paste, a few agent edits.
  const fileSteps = (t) => [
    ['README.md', `# ${t.name}\n\n${t.summary}\n`], ['package.json', `{\n  "name": "${t.name.toLowerCase()}",\n  "dependencies": { "express": "^4.19.0" }\n}\n`],
    ['server.js', "const express = require('express');\nconst app = express();\n"], ['server.js', "const express = require('express');\nconst app = express();\napp.get('/api/health', (_q, r) => r.json({ ok: true }));\n"],
    ['public/index.html', `<h1>${t.name}</h1>\n`], ['public/app.js', "document.title = 'app';\n"], ['server.js', "const express = require('express');\nconst app = express();\napp.use(express.static('public'));\napp.get('/api/health', (_q, r) => r.json({ ok: true }));\napp.listen(3000);\n"],
    ['public/app.js', `// ${'generated table of data '.repeat(30)}\nconst rows = [];\n`], ['public/style.css', 'body { font-family: system-ui; }\n'], ['README.md', `# ${t.name}\n\n${t.summary}\n\n## Run\n\`npm start\`\n`]
  ];
  for (const t of teams) { const authors = t.members.map((i) => people[i]); let n = 0; for (const [path, content] of fileSteps(t)) { await authors[n % authors.length].call('PUT', `/api/projects/${t.workspaceId}/files`, { path, content }); n++; } await authors[0].call('POST', `/api/events/${ev.id}/mentor-requests`, { topic: 'Best way to deploy a small Node app for free?' }); }
  for (const t of teams) await people[t.members[0]].call('PUT', `/api/events/${ev.id}/submission`, { title: t.title, track: t.track, summary: t.summary, agentUsage: t.agent, repoUrl: `https://github.com/example/${t.name.toLowerCase()}`, tech: ['Node.js', 'Express'] });
  await org.call('POST', `/api/events/${ev.id}/announcements`, { text: 'Submissions are open until Sunday 18:00. Good luck!' });
  // Spread the history over ~36 hours so Build Replay and cadence signals are meaningful; mark some agent edits.
  const start = Date.now() - 36 * 3600 * 1000; const agentTeam = teams[1].workspaceId;
  for (const t of teams) { const h = app.db.history[t.workspaceId]; h.forEach((entry, i) => { entry.createdAt = start + Math.round(((i + 1) / (h.length + 1)) * 34 * 3600 * 1000) + (teams.indexOf(t) * 17 * 60000); if (t.workspaceId === agentTeam && [2, 3, 6].includes(i)) { entry.kind = 'agent_edit'; entry.actor = 'Claude Code (MCP, for Jia Rao)'; } }); }
  await org.call('PATCH', `/api/events/${ev.id}`, { status: 'submission' }); await org.call('PATCH', `/api/events/${ev.id}`, { status: 'judging' });
  app.save();
  console.log(`\nSeeded "${ev.title}" in the judging phase.\n\nAll demo accounts use the password: ${PASSWORD}\n  organizer  organizer@demo.hackconnect.dev   (also platform admin)\n  judges     judge1@demo.hackconnect.dev, judge2@demo.hackconnect.dev\n  teams      maya / arjun / jia / lena / omar / priya @demo.hackconnect.dev\n\nStart the app (npm start), sign in as a judge and open Hackathons > Build for Good 2026.`);
} catch (e) { console.error('Seed failed:', e.message); process.exitCode = 1; } finally { await app.close(); }
