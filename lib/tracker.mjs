// "My hackathons": a personal tracker. Entries are added by hand or imported from a calendar (.ics) feed
// (Luma, Google Calendar and many platforms publish one). Each entry has a deadline, a linked project and notes.
// Reminders are written as notifications when a deadline is within REMIND_MS.
import crypto from 'node:crypto';
import { assertSafeAiUrl } from './agent.mjs';

const REMIND_MS = 48 * 3600 * 1000; const MAX_PER_USER = 200;
const PLATFORMS = ['manual', 'luma', 'unstop', 'devpost', 'devfolio', 'mlh', 'other'];
const clean = (v, n) => String(v ?? '').trim().slice(0, n);

export function parseIcs(text) {
  const unfolded = String(text).replace(/\r?\n[ \t]/g, ''); const out = [];
  for (const block of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const body = block.split('END:VEVENT')[0]; const get = (key) => { const m = new RegExp(`^${key}[^:\\n]*:(.*)$`, 'm').exec(body); return m ? m[1].trim().replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';') : ''; };
    const raw = get('DTSTART'); const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?/.exec(raw); if (!m) continue;
    const when = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    const desc = get('DESCRIPTION'); const link = get('URL') || (/https?:\/\/\S+/.exec(desc) || [''])[0];
    out.push({ name: get('SUMMARY') || 'Untitled event', deadline: when, url: link, notes: get('LOCATION') });
  }
  return out;
}

export function createTracker({ db, json, save, notify }) {
  db.tracker ||= [];
  const mine = (user) => db.tracker.filter((t) => t.userId === user.id).sort((a, b) => (a.deadline || Infinity) - (b.deadline || Infinity));
  function fromBody(body, base = {}) {
    const t = { ...base };
    if ('name' in body) t.name = clean(body.name, 120); if ('url' in body) t.url = /^https?:\/\//i.test(clean(body.url, 500)) ? clean(body.url, 500) : '';
    if ('platform' in body) t.platform = PLATFORMS.includes(body.platform) ? body.platform : 'other'; if ('notes' in body) t.notes = clean(body.notes, 1000);
    if ('deadline' in body) { const d = body.deadline === null || body.deadline === '' ? null : Number(body.deadline); t.deadline = Number.isFinite(d) ? d : null; t.reminded = false; t.stages = []; }
    if ('projectId' in body) t.projectId = body.projectId ? clean(body.projectId, 120) : null;
    if ('status' in body) t.status = ['interested', 'registered', 'building', 'submitted', 'done'].includes(body.status) ? body.status : 'interested';
    return t;
  }
  const STAGES = [[72 * 3600e3, '3 days'], [24 * 3600e3, '24 hours'], [3 * 3600e3, '3 hours'], [3600e3, '1 hour'], [15 * 60e3, '15 minutes']];
  /** Staged reminders (3d, 24h, 3h, 1h, 15m). Only the closest stage is announced; earlier ones are marked done. */
  function remindAll(now = Date.now(), only = null) {
    let changed = false;
    for (const t of db.tracker) {
      if (only && t.userId !== only.id) continue;
      if (!t.deadline || t.status === 'submitted' || t.status === 'done' || t.deadline <= now) continue;
      const left = t.deadline - now; t.stages ||= []; let hit = null;
      for (const [ms, label] of STAGES) if (left <= ms) hit = [ms, label];
      if (!hit || t.stages.includes(hit[0])) continue;
      for (const [ms] of STAGES) if (ms >= hit[0] && !t.stages.includes(ms)) t.stages.push(ms);
      t.reminded = true; changed = true;
      notify(t.userId, `Deadline in ${hit[1]}: ${t.name} (${new Date(t.deadline).toUTCString()})`, { type: 'tracker', id: t.id, kind: 'deadline', at: t.deadline });
    }
    if (changed) save();
  }
  const remind = (user) => remindAll(Date.now(), user);
  const handle = async function ({ req, res, user, parts, body }) {
    // parts: ['api','me','hackathons', id?]
    if (parts[1] !== 'me' || parts[2] !== 'hackathons') return false; const method = req.method; const id = parts[3];
    if (!id && method === 'GET') { remind(user); return json(res, 200, { hackathons: mine(user) }), true; }
    if (!id && method === 'POST') {
      const t = fromBody(body, { id: crypto.randomUUID(), userId: user.id, platform: 'manual', status: 'interested', createdAt: Date.now(), reminded: false });
      if (!t.name) return json(res, 400, { error: 'Give the hackathon a name' }), true; if (mine(user).length >= MAX_PER_USER) return json(res, 400, { error: `You can track up to ${MAX_PER_USER} hackathons` }), true;
      db.tracker.push(t); save(); return json(res, 201, t), true;
    }
    if (id === 'import-ics' && method === 'POST') {
      let url; try { url = await assertSafeAiUrl(String(body.url || '').replace(/^webcal:/i, 'https:'), false); } catch (e) { return json(res, 400, { error: e.message }), true; }
      let text; try { const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'HackConnect' } }); if (!r.ok) return json(res, 502, { error: `The calendar answered ${r.status}` }), true; text = (await r.text()).slice(0, 2_000_000); } catch { return json(res, 502, { error: 'Could not download that calendar link' }), true; }
      const platform = PLATFORMS.includes(body.platform) ? body.platform : 'other'; const known = new Set(mine(user).map((t) => `${t.name}|${t.deadline}`)); let added = 0;
      for (const e of parseIcs(text).filter((x) => x.deadline > Date.now() - 86400000).slice(0, 100)) { if (known.has(`${e.name}|${e.deadline}`) || mine(user).length >= MAX_PER_USER) continue; db.tracker.push({ id: crypto.randomUUID(), userId: user.id, platform, status: 'registered', createdAt: Date.now(), reminded: false, projectId: null, ...e, name: clean(e.name, 120), url: /^https?:\/\//i.test(e.url) ? e.url.slice(0, 500) : '', notes: clean(e.notes, 1000) }); added++; }
      save(); return json(res, 200, { added }), true;
    }
    const t = db.tracker.find((x) => x.id === id && x.userId === user.id); if (!t) return json(res, 404, { error: 'Not found' }), true;
    if (method === 'PATCH') { Object.assign(t, fromBody(body, t)); if (!t.name) t.name = 'Untitled'; save(); return json(res, 200, t), true; }
    if (method === 'DELETE') { db.tracker = db.tracker.filter((x) => x !== t); save(); return json(res, 200, { ok: true }), true; }
    return false;
  };
  handle.remindAll = remindAll;
  return handle;
}
