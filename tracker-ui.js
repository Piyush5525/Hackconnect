/* My hackathons tracker: add hackathons by hand or import a calendar feed, attach a project and a deadline, get reminders. */
(() => {
  const HC = window.HC; if (!HC) return;
  const { api, esc, notify, modal, confirmBox } = HC; const $ = (s, r = document) => r.querySelector(s); const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const STATUS = { interested: 'Interested', registered: 'Registered', building: 'Building', submitted: 'Submitted', done: 'Done' };
  const PLAT = { manual: 'Manual', luma: 'Luma', unstop: 'Unstop', devpost: 'Devpost', devfolio: 'Devfolio', mlh: 'MLH', other: 'Other' };
  const main = $('.main .content') || $('.content'); if (!main) return;
  if (!$('#trackerView')) { const s = document.createElement('section'); s.className = 'view'; s.id = 'trackerView'; main.appendChild(s); }
  if (!$('.nav button[data-view="tracker"]')) {
    const b = document.createElement('button'); b.dataset.view = 'tracker'; b.innerHTML = '<span class="nav-icon">◎</span><span>My hackathons</span><span class="nav-count" id="trackerCount" hidden>0</span>';
    const anchor = $('.nav button[data-view="events"]'); anchor ? anchor.after(b) : $('.nav').appendChild(b);
    b.addEventListener('click', () => { show(); load(); });
  }
  const show = () => { $$('.view').forEach(v => v.classList.toggle('active', v.id === 'trackerView')); $$('.nav button[data-view]').forEach(x => x.classList.toggle('active', x.dataset.view === 'tracker')); const c = $('#crumbPage'); if (c) c.textContent = 'My hackathons'; };
  let items = [];
  const left = (t) => { if (!t.deadline) return { text: 'No deadline', cls: '' }; const ms = t.deadline - Date.now(); if (ms < 0) return { text: 'Deadline passed', cls: 'bad' }; const d = Math.floor(ms / 86400000), h = Math.floor(ms % 86400000 / 3600000); return { text: d > 0 ? `${d}d ${h}h left` : `${h}h left`, cls: d < 2 ? 'warn' : 'ok' }; };
  const toLocalInput = (ms) => { if (!ms) return ''; const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };

  async function load() {
    const view = $('#trackerView'); if (!view) return;
    try { items = (await api('/me/hackathons')).hackathons; } catch (e) { notify(e.message); return; }
    const projects = HC.state.projects || []; const open = items.filter(t => !['submitted', 'done'].includes(t.status)); const c = $('#trackerCount'); if (c) { c.textContent = open.length; c.hidden = !open.length; }
    view.innerHTML = `<div class="page-heading"><div><h1>My hackathons</h1><p>Every hackathon you are chasing, with its deadline, the project you are submitting and a reminder before time runs out.</p></div><div class="btn-row"><button class="outline-button" id="trImport">⇪ Import calendar</button><button class="primary-button" id="trAdd">＋ Add hackathon</button></div></div>
      <div class="tr-grid">${items.length ? items.map(t => { const l = left(t); const p = projects.find(x => x.id === t.projectId); return `<article class="card tr-card" data-id="${esc(t.id)}"><div class="tr-top"><span class="chip plat-chip">${window.HCPlatform(t.platform)}${esc(PLAT[t.platform] || 'Other')}</span><span class="chip ${l.cls}">${esc(l.text)}</span></div><h3>${esc(t.name)}</h3><div class="muted small">${t.deadline ? 'Deadline: ' + esc(new Date(t.deadline).toLocaleString()) : 'Set a deadline to get reminders'}</div>
          <div class="tr-proj">${p ? `Project: <a href="#" data-open="${esc(p.id)}">${esc(p.name)}</a>` : '<span class="muted small">No project attached yet</span>'}</div>${t.notes ? `<p class="small muted">${esc(t.notes)}</p>` : ''}
          <div class="btn-row" style="margin-top:12px"><select class="inp" data-status style="width:auto">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${t.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select>${t.url ? `<a class="outline-button btn-sm" href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">Open page ↗</a>` : ''}<button class="outline-button btn-sm" data-edit>Edit</button><button class="outline-button btn-sm" data-del>Remove</button></div></article>`; }).join('') : `<div class="empty" style="grid-column:1/-1"><div style="font-size:34px">◎</div><h3>No hackathons tracked yet</h3><p>Add one by hand, or import the calendar feed (.ics link) from Luma, Google Calendar or any platform that offers one.</p></div>`}</div>`;
    $('#trAdd').addEventListener('click', () => edit()); $('#trImport').addEventListener('click', importIcs);
    $$('.tr-card', view).forEach(card => { const t = items.find(x => x.id === card.dataset.id);
      $('[data-edit]', card).addEventListener('click', () => edit(t));
      $('[data-del]', card).addEventListener('click', async () => { if (await confirmBox?.('Remove hackathon', `Stop tracking ${t.name}?`)) { await api(`/me/hackathons/${t.id}`, { method: 'DELETE' }); load(); } });
      $('[data-status]', card).addEventListener('change', async e => { try { await api(`/me/hackathons/${t.id}`, { method: 'PATCH', body: JSON.stringify({ status: e.target.value }) }); load(); } catch (err) { notify(err.message); } });
      $('[data-open]', card)?.addEventListener('click', e => { e.preventDefault(); HC.openProjectPage?.(e.target.dataset.open); }); });
  }
  function edit(t = null) {
    const projects = HC.state.projects || [];
    const m = modal({ title: t ? 'Edit hackathon' : 'Add hackathon', sub: 'Keep the details and the project you will submit in one place.', width: 520,
      body: `<label class="hc-field">Name<input class="inp" id="trName" maxlength="120" value="${esc(t?.name || '')}" placeholder="Build for Good 2026"></label>
        <label class="hc-field">Platform<select class="inp" id="trPlat">${Object.entries(PLAT).map(([k, v]) => `<option value="${k}" ${(t?.platform || 'manual') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="hc-field">Link<input class="inp" id="trUrl" value="${esc(t?.url || '')}" placeholder="https://..."></label>
        <label class="hc-field">Submission deadline<input class="inp" id="trDl" type="datetime-local" value="${toLocalInput(t?.deadline)}"><small>You get a notification 48 hours before.</small></label>
        <label class="hc-field">Project you will submit<select class="inp" id="trProj"><option value="">None yet</option>${projects.map(p => `<option value="${esc(p.id)}" ${t?.projectId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
        <label class="hc-field">Notes<textarea class="inp" id="trNotes" rows="3" maxlength="1000" placeholder="Rules, tracks, teammates, prizes…">${esc(t?.notes || '')}</textarea></label><div id="trMsg"></div>`,
      actions: [{ label: 'Cancel' }, { label: t ? 'Save' : 'Add', kind: 'primary', keepOpen: true, onClick: async () => {
        const dl = m.$('#trDl').value; const payload = { name: m.$('#trName').value, platform: m.$('#trPlat').value, url: m.$('#trUrl').value, deadline: dl ? new Date(dl).getTime() : null, projectId: m.$('#trProj').value || null, notes: m.$('#trNotes').value };
        if (!payload.name.trim()) { m.$('#trMsg').innerHTML = '<div class="notice bad">Give it a name.</div>'; return false; }
        try { await api(t ? `/me/hackathons/${t.id}` : '/me/hackathons', { method: t ? 'PATCH' : 'POST', body: JSON.stringify(payload) }); m.close(); load(); } catch (e) { m.$('#trMsg').innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; return false; } } }] });
  }
  function importIcs() {
    const m = modal({ title: 'Import a calendar', sub: 'Paste the .ics / webcal link of a calendar. On Luma: open your calendar, then Subscribe, and copy the link.', width: 520,
      body: `<label class="hc-field">Calendar link<input class="inp" id="icsUrl" placeholder="https://api.lu.ma/ics/get?entity=calendar&id=…"></label><label class="hc-field">Platform<select class="inp" id="icsPlat">${Object.entries(PLAT).filter(([k]) => k !== 'manual').map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label><div id="icsMsg"></div>`,
      actions: [{ label: 'Cancel' }, { label: 'Import', kind: 'primary', keepOpen: true, onClick: async () => { try { const r = await api('/me/hackathons/import-ics', { method: 'POST', body: JSON.stringify({ url: m.$('#icsUrl').value.trim(), platform: m.$('#icsPlat').value }) }); m.close(); notify(`${r.added} event${r.added === 1 ? '' : 's'} added`); load(); } catch (e) { m.$('#icsMsg').innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; return false; } } }] });
  }
  window.addEventListener('hc:user', () => api('/me/hackathons').then(r => { const n = r.hackathons.filter(t => !['submitted', 'done'].includes(t.status)).length; const c = $('#trackerCount'); if (c) { c.textContent = n; c.hidden = !n; } }).catch(() => {}));
})();
