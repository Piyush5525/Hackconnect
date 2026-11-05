// Pure helpers for submission artifacts, process signals, replay and scoring. No I/O.

import { reconstruct } from './history.mjs';

const LANGS = { js: 'JavaScript', mjs: 'JavaScript', jsx: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', py: 'Python', css: 'CSS', html: 'HTML', json: 'JSON', md: 'Markdown', go: 'Go', rs: 'Rust', java: 'Java', rb: 'Ruby', sh: 'Shell' };
export const langOf = (path) => LANGS[path.split('.').pop().toLowerCase()] || 'Other';

export function languageStats(files) {
  const lines = {};
  for (const [path, content] of Object.entries(files)) lines[langOf(path)] = (lines[langOf(path)] || 0) + (content ? content.split('\n').length : 0);
  return Object.entries(lines).map(([language, count]) => ({ language, lines: count })).sort((a, b) => b.lines - a.lines);
}

export function dependencies(files) {
  const out = new Set();
  try { const pkg = JSON.parse(files['package.json'] || '{}'); for (const name of [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]) out.add(name); } catch { /* invalid package.json */ }
  for (const line of String(files['requirements.txt'] || '').split('\n')) { const name = line.trim().split(/[=<>~! ]/)[0]; if (name && !name.startsWith('#')) out.add(name); }
  return [...out].sort();
}

export const actorKind = (entry) => (entry.kind === 'agent_edit' || /^HackConnect Agent| \(MCP, for /.test(entry.actor) ? 'agent' : entry.kind === 'bridge_edit' ? 'bridge' : 'human');
export const actorLabel = (entry) => humanName(entry);
const humanName = (entry) => String(entry.actor).replace(/^HackConnect Agent \(for (.*)\)$/, '$1').replace(/^.* \(MCP, for (.*)\)$/, '$1').replace(/^(.*) via Local Bridge \(for (.*)\)$/, '$2').replace(/^(.*) \(Local Bridge\)$/, '$1');
const LARGE_EDIT = 400; // characters added in a single recorded edit (imports and deletions are never paste events)

/** Replay events: metadata only (content stays server-side; fetch state by index). */
export function replayEvents(history) {
  const last = {}; // only used for legacy entries that carry full content and no precomputed size
  return history.map((entry, index) => {
    let size = entry.size; let delta = entry.delta; let added = entry.added;
    if (size === undefined) { const before = last[entry.path] ?? ''; size = entry.content.length; delta = size - before.length; added = Math.max(0, delta); }
    if (entry.content !== undefined) last[entry.path] = entry.content;
    return { index, at: entry.createdAt, path: entry.path, kind: entry.kind, actor: humanName(entry), actorKind: actorKind(entry), size, delta, paste: added >= LARGE_EDIT && entry.kind !== 'agent_edit' && entry.kind !== 'import' && entry.kind !== 'file_deleted' };
  });
}

export function stateAt(history, index) { return reconstruct(history, index); }

export function processSignals(history, memberNames = []) {
  const events = replayEvents(history);
  const byActor = {}; let agent = 0;
  for (const e of events) { if (e.actorKind === 'agent') agent++; else byActor[e.actor] = (byActor[e.actor] || 0) + 1; }
  for (const name of memberNames) byActor[name] ||= 0;
  const humanTotal = Object.values(byActor).reduce((a, b) => a + b, 0);
  const shares = Object.values(byActor).map((n) => (humanTotal ? n / humanTotal : 0));
  const balance = shares.length > 1 ? Math.round(100 * (1 - (Math.max(...shares) - Math.min(...shares)))) : null; // 100 = perfectly even
  const hours = {}; for (const e of events) { const h = Math.floor(e.at / 3600000); hours[h] = (hours[h] || 0) + 1; }
  const span = events.length ? (events[events.length - 1].at - events[0].at) / 3600000 : 0;
  return {
    totalEvents: events.length,
    contributionByMember: Object.entries(byActor).map(([name, edits]) => ({ name, edits })).sort((a, b) => b.edits - a.edits),
    contributionBalance: balance,
    agentAuthoredShare: events.length ? Math.round((100 * agent) / events.length) : 0,
    largePasteEvents: events.filter((e) => e.paste).length,
    activeHours: Object.keys(hours).length, spanHours: Math.round(span * 10) / 10,
    editsPerActiveHour: Object.keys(hours).length ? Math.round((events.length / Object.keys(hours).length) * 10) / 10 : 0,
    firstWorkingVersionIndex: null, // needs the runner (Phase 4); null rather than guessed
    note: 'Informational only. These signals never change scores automatically.'
  };
}

export function weightedTotal(rubric, scores) {
  let got = 0; let max = 0;
  for (const c of rubric) { const v = scores?.[c.id]; if (typeof v !== 'number') continue; got += (c.weight * v) / c.max; max += c.weight; }
  return max ? Math.round((got / max) * 1000) / 10 : null; // 0-100
}

export function validateScores(rubric, scores) {
  if (!scores || typeof scores !== 'object') return 'Scores are required';
  for (const c of rubric) { const v = scores[c.id]; if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > c.max) return `Score for "${c.name}" must be a number from 0 to ${c.max}`; }
  return null;
}

/** Leaderboard with raw average and per-judge z-score normalisation; tie-break by a rubric criterion. */
export function leaderboard(event, submissions, scores, mode = 'raw') {
  const perJudge = {};
  for (const s of scores) (perJudge[s.judgeId] ||= []).push(weightedTotal(event.rubric, s.scores));
  const stats = {}; for (const [j, list] of Object.entries(perJudge)) { const mean = list.reduce((a, b) => a + b, 0) / list.length; const sd = Math.sqrt(list.reduce((a, b) => a + (b - mean) ** 2, 0) / list.length); stats[j] = { mean, sd }; }
  const rows = submissions.map((sub) => {
    const mine = scores.filter((s) => s.submissionId === sub.id); const totals = mine.map((s) => weightedTotal(event.rubric, s.scores));
    const raw = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : null;
    const z = mine.map((s, i) => { const st = stats[s.judgeId]; return st.sd > 0 ? (totals[i] - st.mean) / st.sd : 0; });
    const normalized = z.length ? Math.round((50 + 10 * (z.reduce((a, b) => a + b, 0) / z.length)) * 10) / 10 : null; // T-score style, 50 = average
    const tb = event.tiebreakCriterion ? mine.map((s) => s.scores[event.tiebreakCriterion] ?? 0) : [];
    return { submissionId: sub.id, team: sub.teamName, title: sub.title, judges: mine.length, raw: raw === null ? null : Math.round(raw * 10) / 10, normalized, tiebreak: tb.length ? tb.reduce((a, b) => a + b, 0) / tb.length : 0 };
  });
  const key = mode === 'normalized' ? 'normalized' : 'raw';
  rows.sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1) || b.tiebreak - a.tiebreak || String(a.team).localeCompare(b.team));
  return rows.map((r, i) => ({ rank: i + 1, ...r }));
}

export const csvEscape = (v) => { const s = String(v ?? ''); const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; }; // also defuses spreadsheet formulas

/** Minimal single-page PDF certificate with no dependencies. */
export function certificatePdf({ eventTitle, teamName, rank, members }) {
  const esc = (t) => String(t).replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1');
  const lines = [[26, 'Certificate of Achievement', 120, 440], [14, 'This certifies that team', 120, 390], [24, teamName, 120, 350], [14, rank ? `placed #${rank} at` : 'participated in', 120, 310], [22, eventTitle, 120, 275], [11, `Members: ${members.join(', ')}`, 120, 220], [10, 'Issued by HackConnect', 120, 90]];
  const content = lines.map(([size, text, x, y]) => `BT /F1 ${size} Tf ${x} ${y} Td (${esc(text).slice(0, 90)}) Tj ET`).join('\n');
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'];
  let out = '%PDF-1.4\n'; const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out); out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}
