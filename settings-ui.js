/* Settings page: account, appearance, notifications, AI assistant, integrations, shortcuts, data & privacy. */
(() => {
  const HC = window.HC; if (!HC) return;
  const { api, esc, notify } = HC; const $ = (s, r = document) => r.querySelector(s); const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const main = $('.content'); if (!main) return;
  if (!$('#settingsView')) { const s = document.createElement('section'); s.className = 'view'; s.id = 'settingsView'; main.appendChild(s); }

  // ---- preferences (stored on this device) ----
  const KEY = 'hc-prefs'; const defaults = { accent: '#58e0aa', motion: true, compact: false, browserNotify: false };
  const prefs = () => { try { return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...defaults }; } };
  const savePrefs = (p) => { localStorage.setItem(KEY, JSON.stringify(p)); applyPrefs(p); };
  function applyPrefs(p = prefs()) {
    const r = document.documentElement; r.style.setProperty('--mint', p.accent); r.classList.toggle('no-motion', !p.motion); r.classList.toggle('compact', p.compact);
    let st = $('#hcAccent'); if (!st) { st = document.createElement('style'); st.id = 'hcAccent'; document.head.appendChild(st); }
    st.textContent = `.primary-button{background:${p.accent}!important}`;
  }
  applyPrefs();

  const open = () => {
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'settingsView')); $$('.nav button[data-view]').forEach(b => b.classList.remove('active'));
    const c = $('#crumbPage'); if (c) c.textContent = 'Settings'; render(sessionStorage.getItem('hc-settings-tab') || 'account'); window.scrollTo({ top: 0 });
  };
  const TABS = [['account', 'Account'], ['appearance', 'Appearance'], ['notifications', 'Notifications'], ['ai', 'AI assistant'], ['integrations', 'Integrations'], ['shortcuts', 'Shortcuts'], ['data', 'Data & privacy']];
  const row = (title, desc, control) => `<div class="set-row"><div><b>${title}</b><div class="muted small">${desc}</div></div><div>${control}</div></div>`;
  const toggle = (id, on) => `<label class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span></span></label>`;

  async function render(tab) {
    sessionStorage.setItem('hc-settings-tab', tab); const view = $('#settingsView'); const u = HC.state.user; if (!u) return; const p = prefs();
    view.innerHTML = `<div class="page-heading"><div><h1>Settings</h1><p>Make HackConnect work the way you do.</p></div></div><div class="set-layout"><nav class="set-nav">${TABS.map(([k, v]) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${v}</button>`).join('')}</nav><div class="card set-body" id="setBody"><div class="muted">Loading…</div></div></div>`;
    $$('.set-nav button', view).forEach(b => b.addEventListener('click', () => render(b.dataset.tab)));
    const body = $('#setBody'); let html = '';
    if (tab === 'account') html = `<div class="btn-row" style="margin-bottom:12px">${HC.av(u, 54)}<div><b style="font-size:17px">${esc(u.name)}</b><div class="muted">@${esc(u.username)} · ${esc(u.email)}</div></div></div>${row('Profile', 'Username, display name and bio that teammates see.', '<button class="outline-button" id="stProfile">Edit profile</button>')}${row('Password & sign-in', 'Connected sign-in methods are in Integrations.', '<button class="outline-button" id="stConn">Connections</button>')}${row('Sign out', 'End this session on this device.', '<button class="outline-button" id="stOut">Sign out</button>')}`;
    if (tab === 'appearance') html = `${row('Accent colour', 'Used for buttons and highlights.', ['#58e0aa', '#7aa2ff', '#c792ea', '#ffb454', '#ff7a90'].map(c => `<button class="swatch ${c === p.accent ? 'on' : ''}" data-c="${c}" style="background:${c}" aria-label="Accent ${c}"></button>`).join(''))}${row('Animations', 'Hover effects, fades and the moving background. Turn off for a calmer, faster feel.', toggle('stMotion', p.motion))}${row('Compact layout', 'Tighter spacing to fit more on screen.', toggle('stCompact', p.compact))}`;
    if (tab === 'notifications') html = `${row('Hackathon deadline reminders', 'You are always notified in the bell 48 hours before a deadline you added in My hackathons.', '<span class="chip ok">On</span>')}${row('Browser notifications', typeof Notification === 'undefined' ? 'Not supported in this browser.' : 'Also pop up a desktop notification while HackConnect is open.', toggle('stBrowser', p.browserNotify && typeof Notification !== 'undefined' && Notification.permission === 'granted'))}`;
    if (tab === 'ai') { let ai = {}; try { ai = await api('/me/ai'); } catch { /* ignore */ } const preset = (ai.presets || []).find(x => x.id === ai.provider); html = `${row('Current assistant', ai.provider && ai.provider !== 'demo' ? `${esc(preset?.label || ai.provider)}${ai.model ? ' · ' + esc(ai.model) : ''}` : 'Demo mode: no real model is connected, so it cannot write code yet.', '<button class="primary-button" id="stAi">Choose model / add key</button>')}${row('Use Claude Code, Codex or Cursor', 'Open a project, then use Connect agent in the editor to get a token and a ready-made command.', '')}<div class="muted small" style="margin-top:8px">Your key is stored encrypted and only used for your own requests.</div>`; }
    if (tab === 'integrations') { let st = {}, ids = { identities: [] }; try { [st, ids] = await Promise.all([api('/integrations/status'), api('/me/identities')]); } catch { /* ignore */ } html = `${row('GitHub', st.github ? 'Connected with repository access. Your repos can be imported from My projects.' : 'Not connected. Connect to import your repositories.', st.githubSignIn ? `<a class="${st.github ? 'outline-button' : 'primary-button'}" href="/api/auth/oauth/github/start?link=1">${st.github ? 'Reconnect' : 'Connect GitHub'}</a>` : '<span class="muted small">Not configured on this server</span>')}${row('Linked accounts', ids.identities.length ? ids.identities.map(i => esc(i.provider + (i.handle ? ' @' + i.handle : ''))).join(', ') : 'None yet.', '<button class="outline-button" id="stConn2">Manage</button>')}${row('Editor extensions & downloads', 'Local bridge, VS Code and agent tools.', '<button class="outline-button" id="stExt">Open</button>')}${row('Hackathon platforms', 'Luma and Google Calendar import through a calendar link. Add Unstop and others by hand.', '<button class="outline-button" id="stTrack">My hackathons</button>')}`; }
    if (tab === 'shortcuts') html = [['Ctrl / ⌘ + K', 'Open the command palette'], ['Ctrl / ⌘ + B', 'Hide or show the sidebar'], ['Ctrl / ⌘ + S', 'Save the current file'], ['Ctrl / ⌘ + P', 'Quick-open a file in the editor'], ['Esc', 'Close dialogs']].map(([k, d]) => row(d, '', `<kbd class="kbd">${k}</kbd>`)).join('');
    if (tab === 'data') html = `${row('Download my data', 'Everything we store about you, as JSON.', '<a class="outline-button" href="/api/me/export" download="hackconnect-data.json">Download</a>')}${row('Delete account', 'Projects only you own are deleted. This cannot be undone.', '<button class="outline-button" id="stDel" style="color:#ff9b9b;border-color:#ff9b9b">Delete account</button>')}`;
    body.innerHTML = html;
    const on = (id, fn) => $(id, body)?.addEventListener('click', fn);
    on('#stProfile', () => HC.openProfile?.()); on('#stConn', () => HC.showConnections()); on('#stConn2', () => HC.showConnections()); on('#stExt', () => HC.openExtensions()); on('#stAi', () => HC.openAssistantSettings());
    on('#stTrack', () => $('.nav button[data-view="tracker"]')?.click()); on('#stDel', () => HC.openProfile?.());
    on('#stOut', async () => { await api('/auth/logout', { method: 'POST', body: '{}' }).catch(() => {}); location.reload(); });
    $$('.swatch', body).forEach(b => b.addEventListener('click', () => { savePrefs({ ...prefs(), accent: b.dataset.c }); render('appearance'); }));
    $('#stMotion', body)?.addEventListener('change', e => savePrefs({ ...prefs(), motion: e.target.checked })); $('#stCompact', body)?.addEventListener('change', e => savePrefs({ ...prefs(), compact: e.target.checked }));
    $('#stBrowser', body)?.addEventListener('change', async e => { if (e.target.checked) { const r = await Notification.requestPermission(); if (r !== 'granted') { e.target.checked = false; notify('Notifications are blocked in your browser settings'); return; } } savePrefs({ ...prefs(), browserNotify: e.target.checked }); });
  }

  // ---- desktop reminders for deadlines (only when enabled) ----
  async function checkDeadlines() { if (!HC.state.user || !prefs().browserNotify || typeof Notification === 'undefined' || Notification.permission !== 'granted') return; try { const { hackathons } = await api('/me/hackathons'); const seen = JSON.parse(localStorage.getItem('hc-seen-reminders') || '[]'); for (const t of hackathons) if (t.deadline && t.deadline > Date.now() && t.deadline - Date.now() < 48 * 3600e3 && !['submitted', 'done'].includes(t.status) && !seen.includes(t.id)) { new Notification(`Deadline soon: ${t.name}`, { body: new Date(t.deadline).toLocaleString() }); seen.push(t.id); } localStorage.setItem('hc-seen-reminders', JSON.stringify(seen.slice(-200))); } catch { /* offline */ } }
  setInterval(checkDeadlines, 10 * 60e3); window.addEventListener('hc:user', () => setTimeout(checkDeadlines, 2000));


  // ---- collapsible sidebar: the toggle sits inside the sidebar; a slim handle brings it back when hidden. Ctrl/Cmd + B also toggles ----
  (() => {
    const app = $('.app'); const side = $('.sidebar'); if (!app || !side || $('#sideToggle')) return;
    const b = document.createElement('button'); b.id = 'sideToggle'; b.type = 'button'; b.setAttribute('aria-label', 'Hide sidebar'); b.title = 'Hide sidebar (Ctrl+B)';
    b.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path class="sb-bar" d="M9 4v16"/><path class="sb-arrow" d="M16 9l-3 3 3 3"/></svg>'; ($('.brand', side) || side).appendChild(b);
    const h = document.createElement('button'); h.id = 'sideHandle'; h.type = 'button'; h.setAttribute('aria-label', 'Show sidebar'); h.title = 'Show sidebar (Ctrl+B)'; h.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>'; document.body.appendChild(h);
    const set = (off) => { app.classList.toggle('side-off', off); localStorage.setItem('hc-side-off', off ? '1' : '0'); setTimeout(() => window.dispatchEvent(new Event('resize')), 280); };
    const flip = () => set(!app.classList.contains('side-off')); b.addEventListener('click', flip); h.addEventListener('click', flip);
    document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b' && !e.shiftKey) { e.preventDefault(); flip(); } });
    set(localStorage.getItem('hc-side-off') === '1');
  })();

  const btn = $('#settingsBtn'); if (btn) { const c = btn.cloneNode(true); btn.replaceWith(c); c.addEventListener('click', open); }
  HC.openSettings = open;
})();
