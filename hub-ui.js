/* Team hub: project channels, discussion threads, the shift-handover channel and direct messages.
   Messaging runs on the Nexconn Chat SDK (window.HCNex, loaded on demand from /vendor/nexconn-client.js). The server only
   issues each person's access token and keeps Nexconn group membership equal to project membership (see lib/nexconn.mjs).
   Builds on window.HC (exposed by app.js). */
(() => {
  const HC = window.HC; if (!HC) return;
  const { api, esc, notify, modal, av, confirmBox } = HC;
  const $ = (s, r = document) => r.querySelector(s); const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const md = (text) => (window.HCCollab?.renderMarkdown ? window.HCCollab.renderMarkdown(text) : `<p>${esc(text)}</p>`);
  const icon = (d, size = 16) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const I = {
    hub: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/>', hash: '<path d="M5 9h14M5 15h14M10 4L8 20M16 4l-2 16"/>', swap: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', send: '<path d="M5 12l14-7-5 15-3-6z"/>', spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
    code: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4"/>', phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z"/>', smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14a4 4 0 007 0M9 9.5h.01M15 9.5h.01"/>',
    reply: '<path d="M9 8L4 12l5 4"/><path d="M4 12h10a6 6 0 016 6"/>', check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>', trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>', back: '<path d="M15 5l-7 7 7 7"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>',
  };
  const REACTIONS = [['r_up', '👍'], ['r_heart', '❤️'], ['r_joy', '😂'], ['r_party', '🎉'], ['r_rocket', '🚀'], ['r_eyes', '👀'], ['r_check', '✅']];
  const EMOJI = '😀 😂 😊 😍 🤔 😅 😭 🥳 👍 👏 🙌 🙏 💪 🔥 🚀 ✅ ❌ 🐛 💡 🎯 ☕ 🍕 ❤️ ✨'.split(' ');
  const HANDOVER = 'HC:Handover';

  const S = { enabled: null, ready: false, connecting: false, me: null, C: null, hub: { projects: [], people: {} }, current: null, msgs: new Map(), queries: new Map(), unread: new Map(), last: new Map(), typing: new Map(), seen: new Map(), aiMode: false, reply: null, thinking: new Set(), status: 'offline', lastHubLoad: 0, animate: new Set() };
  window.HC.hub = S;
  const keyOf = (cur) => (cur ? `${cur.type}:${cur.id}` : ''); const person = (nx) => S.hub.people[nx] || { nx, name: 'Former teammate', initials: '?', username: '' };
  const projectOf = (cur) => S.hub.projects.find((p) => p.id === cur?.projectId); const channelOf = (cur) => projectOf(cur)?.channels.find((c) => c.id === cur.id);
  const sdkChannel = (cur) => (cur.type === 'group' ? new S.C.GroupChannel(cur.id) : new S.C.DirectChannel(cur.id));
  const identifier = (cur) => (cur.type === 'group' ? new S.C.GroupChannelIdentifier(cur.id) : new S.C.DirectChannelIdentifier(cur.id));
  const fromIdentifier = (id) => ({ type: id.channelType === S.C.ChannelType.GROUP ? 'group' : 'direct', id: id.channelId });
  const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dayLabel = (ms) => { const d = new Date(ms); const today = new Date(); const y = new Date(Date.now() - 864e5); if (d.toDateString() === today.toDateString()) return 'Today'; if (d.toDateString() === y.toDateString()) return 'Yesterday'; return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }); };

  // ---------- message model ----------
  function norm(m) {
    const c = m.content || {}; const meta = {}; if (m.metadata instanceof Map) m.metadata.forEach((v, k) => { meta[k] = v; }); else if (m.metadata) Object.assign(meta, m.metadata);
    let extra = {}; try { extra = JSON.parse(c.extra || c.senderUserInfo?.extra || '{}') || {}; } catch { extra = {}; }
    return { id: m.messageId, type: m.messageType, from: m.senderUserId || S.me, at: m.sentTime || Date.now(), text: String(c.text ?? (typeof c.content === 'string' ? c.content : '') ?? ''), content: c, meta, extra, raw: m };
  }
  const listFor = (key) => { if (!S.msgs.has(key)) S.msgs.set(key, []); return S.msgs.get(key); };
  function addMessage(key, msg, { front = false } = {}) { const list = listFor(key); if (!msg.id || list.some((x) => x.id === msg.id)) return false; front ? list.unshift(msg) : list.push(msg); if (!front) list.sort((a, b) => a.at - b.at); return true; }
  const preview = (msg) => (msg.type === HANDOVER ? 'Left a handover' : msg.text.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').slice(0, 80) || 'Sent a message');

  // ---------- connect ----------
  const loadSdk = () => (window.HCNex ? Promise.resolve() : new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = '/vendor/nexconn-client.js'; s.onload = resolve; s.onerror = () => reject(new Error('Could not load the messaging SDK')); document.head.appendChild(s); }));
  async function start() {
    if (S.ready || S.connecting || !HC.state.user) return; S.connecting = true;
    try {
      const session = await api('/nexconn/session'); S.enabled = Boolean(session.enabled); if (!S.enabled) { render(); return; }
      await loadSdk(); const C = S.C = window.HCNex.chat; S.me = session.userId;
      if (!start.initialized) {
        start.initialized = true; C.NCEngine.initialize({ appKey: session.appKey });
        C.NCEngine.registerCustomMessages([{ messageType: HANDOVER, isPersisted: true, isCounted: true }]);
        C.NCEngine.addConnectionStatusHandler('hub', new C.ConnectionStatusHandler({ onConnectionStatusChanged: ({ status }) => { const was = S.status; S.status = status === 0 ? 'live' : status === 1 ? 'connecting' : 'offline'; paintStatus(); if (S.status === 'live' && was !== 'live' && S.ready && S.current) loadHistory(S.current, { fresh: true }); } }));
        C.NCEngine.addMessageHandler('hub', new C.MessageHandler({
          onMessageReceived: ({ messages }) => { for (const m of messages) { try { onIncoming(m); } catch (error) { console.error(error); } } },
          onMessageMetadataUpdated: ({ messageId, channelIdentifier, metadata }) => patchMeta(fromIdentifier(channelIdentifier), messageId, (meta) => Object.assign(meta, metadata)),
          onMessageMetadataDeleted: ({ messageId, channelIdentifier, keys }) => patchMeta(fromIdentifier(channelIdentifier), messageId, (meta) => { for (const k of keys) delete meta[k]; }),
          onMessageReceiptResponse: ({ responses }) => { for (const r of responses || []) { if ((r.readCount || r.users?.length) && r.channelIdentifier) { const key = keyOf(fromIdentifier(r.channelIdentifier)); S.seen.set(key, Math.max(S.seen.get(key) || 0, Date.now())); S.seenIds = (S.seenIds || new Set()).add(r.messageId); } } if (S.current?.type === 'direct') paintMessages(); },
        }));
        C.NCEngine.addChannelHandler('hub', new C.ChannelHandler({ onTypingStatusChanged: ({ channelIdentifier, userTypingStatus }) => { const key = keyOf(fromIdentifier(channelIdentifier)); const others = (userTypingStatus || []).filter((u) => u.userId !== S.me); clearTimeout(S.typing.get(key)?.timer); if (others.length) S.typing.set(key, { who: others[0].userId, timer: setTimeout(() => { S.typing.delete(key); paintTyping(); }, 6000) }); else S.typing.delete(key); paintTyping(); } }));
      }
      const result = await C.NCEngine.connect({ token: session.token }); if (!result.isOk) throw new Error(`Messaging sign-in failed (${result.code})`);
      S.status = 'live'; await loadHub(); await loadUnread(); S.ready = true; render();
    } catch (error) { console.error(error); S.error = error.message; render(); } finally { S.connecting = false; }
  }
  async function loadHub() { const hub = await api('/hub'); S.hub = hub; S.lastHubLoad = Date.now(); if (S.current && S.current.type === 'group' && !channelOf(S.current)) S.current = null; }
  async function loadUnread() {
    try { const q = S.C.BaseChannel.createChannelsQuery({ pageSize: 100 }); const r = await q.loadNextPage(); for (const c of r.data?.data || []) { const cur = { type: c.channelType === S.C.ChannelType.GROUP ? 'group' : c.channelType === S.C.ChannelType.DIRECT ? 'direct' : null, id: c.channelId }; if (!cur.type) continue; S.unread.set(keyOf(cur), c.unreadCount || 0); if (c.latestMessage) S.last.set(keyOf(cur), norm(c.latestMessage)); } } catch (error) { console.error(error); }
    paintBadge();
  }

  function onIncoming(raw) {
    const cur = fromIdentifier(raw.channelIdentifier); const key = keyOf(cur); const msg = norm(raw); if (cur.type === 'direct' && msg.from === S.me) { /* my own message synced from another tab */ }
    if (msg.extra.ai) { S.thinking.delete(key); S.animate.add(msg.id); }
    if (cur.type === 'group' && !S.hub.projects.some((p) => p.channels.some((c) => c.id === cur.id))) loadHub().then(() => { paintSidebar(); paintBadge(); }).catch(() => {}); // a thread someone just started
    const added = addMessage(key, msg); if (!added) return; S.last.set(key, msg);
    const open = keyOf(S.current) === key && isVisible();
    if (open) { paintMessages({ stick: true }); markRead(S.current); } else if (msg.from !== S.me) { S.unread.set(key, (S.unread.get(key) || 0) + 1); paintSidebar(); paintBadge(); toast(cur, msg); }
    if (keyOf(S.current) === key && !isVisible()) paintMessages({ stick: true });
    if (msg.type === HANDOVER) paintAside();
  }
  let lastToast = 0;
  function toast(cur, msg) { if (Date.now() - lastToast < 4000) return; lastToast = Date.now(); const where = cur.type === 'direct' ? 'sent you a message' : `in #${S.hub.projects.flatMap((p) => p.channels).find((c) => c.id === cur.id)?.name || 'a channel'}`; notify(`${person(msg.from).name} ${where}: ${preview(msg)}`); }
  function patchMeta(cur, messageId, change) { const msg = listFor(keyOf(cur)).find((m) => m.id === messageId); if (!msg) return; change(msg.meta); if (keyOf(S.current) === keyOf(cur)) paintMessages(); }
  const isVisible = () => $('#hubView')?.classList.contains('active') && !document.hidden;
  function markRead(cur) {
    const key = keyOf(cur); if (S.unread.get(key)) { S.unread.set(key, 0); paintSidebar(); paintBadge(); }
    try { sdkChannel(cur).clearUnreadCount(); if (cur.type === 'direct') { const ids = listFor(key).filter((m) => m.from !== S.me && m.raw.needReceipt && !m.receipted).map((m) => { m.receipted = true; return m.id; }); if (ids.length) sdkChannel(cur).sendReadReceiptResponse(ids); } } catch (error) { console.error(error); }
  }

  async function loadHistory(cur, { fresh = false, older = false } = {}) {
    const key = keyOf(cur); let query = S.queries.get(key);
    if (!query || fresh) { query = S.C.BaseChannel.createMessagesQuery({ channelIdentifier: identifier(cur), startTime: 0, pageSize: 30, isAscending: false }); S.queries.set(key, query); if (fresh) S.msgs.set(key, listFor(key).filter(() => false)); } else if (!older) return;
    if (older && !query.hasNext) return;
    const r = await query.loadNextPage(); if (!r.isOk) { if (keyOf(S.current) === key) paintMessages(); return; }
    for (const raw of r.data?.data || []) addMessage(key, norm(raw)); listFor(key).sort((a, b) => a.at - b.at);
    if (cur.type === 'direct') { const mine = listFor(key).filter((m) => m.from === S.me).slice(-1)[0]; if (mine) sdkChannel(cur).getMessageReadReceiptInfo([mine.id]).then((info) => { const row = info.data?.[0]; if (row && (row.readCount || row.users?.length)) { (S.seenIds ||= new Set()).add(mine.id); if (keyOf(S.current) === key) paintMessages(); } }).catch(() => {}); }
  }

  // ---------- actions ----------
  async function open(cur) {
    S.current = cur; S.reply = null; S.aiMode = false; try { localStorage.setItem('hc.hub.current', JSON.stringify(cur)); } catch { /* private mode */ }
    render(); const key = keyOf(cur); const first = !S.queries.has(key);
    if (first) { $('#hubMsgs')?.classList.add('loading'); try { await loadHistory(cur); } catch (error) { console.error(error); } }
    if (keyOf(S.current) !== key) return; paintMessages({ stick: true }); markRead(cur); paintAside(); $('#hubInput')?.focus();
  }
  async function sendText(text, { ai = false } = {}) {
    const cur = S.current; if (!cur || !text.trim()) return; const C = S.C; const params = new C.SendTextMessageParams({ text: text.trim() });
    const meta = { hc: '1' }; if (ai) meta.ai = '1'; if (S.reply) meta.re = JSON.stringify({ id: S.reply.id, name: person(S.reply.from).name, text: preview(S.reply) }); params.metadata = meta; if (cur.type === 'direct') params.needReceipt = true;
    S.reply = null; paintReply(); const r = await sdkChannel(cur).sendMessage(params);
    if (!r.isOk) { notify(`Message not sent (${r.code}). Check your connection and try again.`); return false; }
    const msg = norm(r.data); Object.assign(msg.meta, meta); addMessage(keyOf(cur), msg); S.last.set(keyOf(cur), msg); if (keyOf(S.current) === keyOf(cur)) paintMessages({ stick: true }); paintSidebar();
    if (ai && cur.type === 'group') askAssistant(cur, text.trim()); return true;
  }
  async function askAssistant(cur, prompt) {
    const key = keyOf(cur); S.thinking.add(key); paintMessages({ stick: true });
    try { await api(`/projects/${encodeURIComponent(cur.projectId)}/channels/${cur.id}/ask`, { method: 'POST', body: JSON.stringify({ prompt }) }); setTimeout(() => { if (S.thinking.delete(key) && keyOf(S.current) === key) paintMessages(); }, 8000); } catch (error) { S.thinking.delete(key); paintMessages(); notify(error.message); }
  }
  async function react(msg, key) {
    const users = (msg.meta[key] || '').split(',').filter(Boolean); const next = users.includes(S.me) ? users.filter((u) => u !== S.me) : [...users, S.me];
    try { const r = next.length ? await msg.raw.setMetadata({ [key]: next.join(',') }) : await msg.raw.deleteMetadata([key]); if (r && r.isOk === false) throw new Error(String(r.code)); if (next.length) msg.meta[key] = next.join(','); else delete msg.meta[key]; paintMessages(); if (msg.type === HANDOVER) paintAside(); } catch { notify('Could not save your reaction. Try again.'); }
  }
  function newThread(projectId) {
    const m = modal({ title: 'Start a discussion thread', sub: 'A thread is its own channel for one topic, so the main channel stays readable. Everyone on the project can join in.', width: 460,
      body: `<label class="hc-field">Thread name<input class="inp" id="thName" autofocus maxlength="40" autocomplete="off" placeholder="e.g. api-design, demo-script, bug-login"><small>Short and specific. Lowercase with dashes.</small></label><label class="hc-field">What is it about? (optional)<input class="inp" id="thTopic" maxlength="200" autocomplete="off" placeholder="Decide the REST shape for /rooms before midnight"></label>`,
      actions: [{ label: 'Cancel' }, { label: 'Start thread', kind: 'primary', id: 'ok', onClick: async () => { const name = m.$('#thName').value.trim(); if (name.length < 2) { notify('Give the thread a short name'); return false; } const channel = await api(`/projects/${encodeURIComponent(projectId)}/channels`, { method: 'POST', body: JSON.stringify({ name, topic: m.$('#thTopic').value.trim() }) }); await loadHub(); open({ type: 'group', id: channel.id, projectId }); } }] });
    m.$('#thName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); m.$('[data-act=ok]').click(); } });
  }
  function handoverForm(projectId) {
    const p = S.hub.projects.find((x) => x.id === projectId); if (!p) return; const target = p.channels.find((c) => c.kind === 'handover'); if (!target) return notify('This project has no handover channel yet. Reload and try again.');
    const mates = p.members.filter((mm) => mm.nx !== S.me).map((mm) => person(mm.nx));
    const m = modal({ title: 'Leave a handover', sub: `Going offline? Tell <b>${esc(p.name)}</b> where things stand so the next person can pick up without waking you.`, width: 540,
      body: `<label class="hc-field">Done <span class="muted">(what you finished this shift)</span><textarea class="inp" id="hoDone" rows="3" autofocus placeholder="Login flow works end to end. Seeded demo data."></textarea></label><label class="hc-field">Next <span class="muted">(what should happen now)</span><textarea class="inp" id="hoNext" rows="3" placeholder="Wire the results page to /api/scores. Record the demo video."></textarea></label><label class="hc-field">Blocked / watch out<textarea class="inp" id="hoBlocked" rows="2" placeholder="Maps API key is rate limited, use the cached tiles."></textarea></label><label class="hc-field">Handing over to<select class="inp" id="hoTo"><option value="">The whole team</option>${mates.map((u) => `<option value="${esc(u.nx)}">${esc(u.name)}</option>`).join('')}</select></label>`,
      actions: [{ label: 'Cancel' }, { label: 'Post handover', kind: 'primary', onClick: async () => {
        const done = m.$('#hoDone').value.trim(); const next = m.$('#hoNext').value.trim(); const blocked = m.$('#hoBlocked').value.trim(); const to = m.$('#hoTo').value; if (!done && !next && !blocked) { notify('Write at least one line so your team knows where things stand'); return false; }
        const params = new S.C.SendMessageParams({ done, next, blocked, to, toName: to ? person(to).name : '' }, HANDOVER); params.metadata = { hc: '1' };
        const cur = { type: 'group', id: target.id, projectId }; const r = await sdkChannel(cur).sendMessage(params); if (!r.isOk) { notify(`Handover not posted (${r.code}). Try again.`); return false; }
        addMessage(keyOf(cur), Object.assign(norm(r.data), { meta: { hc: '1' } })); notify('Handover posted'); open(cur);
      } }] });
  }
  async function archive(cur) { const c = channelOf(cur); if (!c) return; if (!await confirmBox(`Archive #${c.name}?`, 'The thread and its messages are removed for everyone on the project. This cannot be undone.', { confirm: 'Archive thread', danger: true })) return; try { await api(`/projects/${encodeURIComponent(cur.projectId)}/channels/${cur.id}`, { method: 'DELETE' }); await loadHub(); const p = S.hub.projects.find((x) => x.id === cur.projectId); open({ type: 'group', id: p.channels[0].id, projectId: p.id }); } catch (error) { notify(error.message); } }

  // ---------- rendering ----------
  function ensureView() {
    if (!$('.nav button[data-view="hub"]')) {
      const b = document.createElement('button'); b.dataset.view = 'hub'; b.innerHTML = `<span class="nav-icon">${icon(I.hub, 17)}</span><span>Team hub</span><span class="nav-count" id="hubCount" hidden>0</span>`;
      const anchor = $('.nav button[data-view="workspace"]'); anchor ? anchor.after(b) : $('.nav')?.appendChild(b); b.addEventListener('click', show);
    }
    if (!$('#hubView')) { const s = document.createElement('section'); s.className = 'view'; s.id = 'hubView'; $('.content')?.appendChild(s); }
  }
  function show() {
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'hubView')); $$('.nav button[data-view]').forEach((x) => x.classList.toggle('active', x.dataset.view === 'hub')); const c = $('#crumbPage'); if (c) c.textContent = 'Team hub';
    if (!S.ready) start(); else { if (Date.now() - S.lastHubLoad > 15000) loadHub().then(render).catch(() => {}); if (S.current) { paintMessages({ stick: true }); markRead(S.current); } }
    render();
  }
  function pickDefault() {
    if (S.current) return; let saved = null; try { saved = JSON.parse(localStorage.getItem('hc.hub.current') || 'null'); } catch { saved = null; }
    if (saved && ((saved.type === 'group' && S.hub.projects.some((p) => p.id === saved.projectId && p.channels.some((c) => c.id === saved.id))) || (saved.type === 'direct' && S.hub.people[saved.id]))) return open(saved);
    const p = S.hub.projects.find((x) => x.channels.length); if (p) open({ type: 'group', id: p.channels[0].id, projectId: p.id });
  }
  function render() {
    const view = $('#hubView'); if (!view) return;
    if (S.enabled === false) { view.innerHTML = `<div class="hub-empty"><div class="hub-empty-ic">${icon(I.hub, 30)}</div><h2>Team hub is not switched on</h2><p>This server has no Nexconn keys yet. Add <code>NEXCONN_KEY</code> and <code>NEXCONN_SECRET</code> to its environment and restart to get project channels, threads, handovers and direct messages.</p></div>`; return; }
    if (S.error && !S.ready) { view.innerHTML = `<div class="hub-empty"><div class="hub-empty-ic">${icon(I.hub, 30)}</div><h2>Could not connect to messaging</h2><p>${esc(S.error)}</p><button class="primary-button" id="hubRetry">Try again</button></div>`; $('#hubRetry').addEventListener('click', () => { S.error = null; render(); start(); }); return; }
    if (!S.ready) { view.innerHTML = '<div class="hub-empty"><div class="hub-spin"></div><p>Connecting your team hub…</p></div>'; return; }
    if (!$('.hub', view)) {
      view.innerHTML = `<div class="hub"><aside class="hub-side" id="hubSide"></aside><section class="hub-main" id="hubMain"></section><aside class="hub-aside" id="hubAside"></aside></div>`;
      view.addEventListener('click', onClick);
    }
    $('.hub', view).classList.toggle('has-current', Boolean(S.current)); paintSidebar(); paintMain(); paintAside(); pickDefault(); fit();
  }
  /** Fill the space under the top bar (and any banner above the hub) without making the page scroll. */
  function fit() { const hub = $('.hub'); if (!hub || !$('#hubView')?.classList.contains('active')) return; hub.style.height = innerWidth > 860 ? `${Math.max(460, innerHeight - (hub.getBoundingClientRect().top + scrollY) - 26)}px` : ''; }
  addEventListener('resize', fit);
  const statusText = () => (S.status === 'live' ? 'Live' : S.status === 'connecting' ? 'Reconnecting…' : 'Offline');
  function paintStatus() { const el = $('#hubStatus'); if (el) { el.className = `hub-status ${S.status}`; el.textContent = statusText(); } }
  function paintBadge() { let total = 0; S.unread.forEach((n) => { total += n; }); const el = $('#hubCount'); if (el) { el.hidden = !total; el.textContent = total > 99 ? '99+' : total; } }
  const badge = (key) => { const n = S.unread.get(key) || 0; return n ? `<span class="hub-badge">${n > 99 ? '99+' : n}</span>` : ''; };
  function paintSidebar() {
    const side = $('#hubSide'); if (!side) return; const curKey = keyOf(S.current);
    const projects = S.hub.projects.map((p) => `<div class="hub-group"><div class="hub-group-h"><span title="${esc(p.name)}">${esc(p.name)}</span>${p.role !== 'viewer' ? `<button class="hub-mini" data-act="thread" data-project="${esc(p.id)}" title="Start a discussion thread" aria-label="Start a discussion thread in ${esc(p.name)}">${icon(I.plus, 14)}</button>` : ''}</div>${p.ready === false ? '<div class="hub-note">Channels are still being prepared. Reopen the hub in a moment.</div>' : ''}${p.channels.map((c) => { const key = `group:${c.id}`; return `<button class="hub-item${key === curKey ? ' on' : ''}${S.unread.get(key) ? ' unread' : ''}" data-act="open" data-type="group" data-id="${esc(c.id)}" data-project="${esc(p.id)}"><span class="hub-item-ic ${c.kind}">${icon(c.kind === 'handover' ? I.swap : I.hash, 15)}</span><span class="hub-item-t">${esc(c.name)}</span>${badge(key)}</button>`; }).join('')}</div>`).join('');
    const people = Object.values(S.hub.people).filter((u) => u.nx !== S.me && !u.bot).sort((a, b) => ((S.last.get(`direct:${b.nx}`)?.at || 0) - (S.last.get(`direct:${a.nx}`)?.at || 0)) || a.name.localeCompare(b.name));
    const dms = people.map((u) => { const key = `direct:${u.nx}`; const last = S.last.get(key); return `<button class="hub-item dm${key === curKey ? ' on' : ''}${S.unread.get(key) ? ' unread' : ''}" data-act="open" data-type="direct" data-id="${esc(u.nx)}">${av(u, 26)}<span class="hub-item-t">${esc(u.name)}${last ? `<small>${last.from === S.me ? 'You: ' : ''}${esc(preview(last))}</small>` : ''}</span>${badge(key)}</button>`; }).join('');
    side.innerHTML = `<div class="hub-side-h"><div><h2>Team hub</h2><span class="hub-status ${S.status}" id="hubStatus">${statusText()}</span></div></div><div class="hub-scroll">${projects || '<div class="hub-note">Create or join a project and its channels appear here.</div>'}<div class="hub-group"><div class="hub-group-h"><span>Direct messages</span></div>${dms || '<div class="hub-note">Teammates you share a project with show up here.</div>'}</div></div><div class="hub-powered">Messaging by Nexconn</div>`;
  }
  function paintMain() {
    const main = $('#hubMain'); if (!main) return; const cur = S.current;
    if (!cur) { main.innerHTML = `<div class="hub-empty"><div class="hub-empty-ic">${icon(I.hub, 30)}</div><h2>Your team, in one place</h2><p>${S.hub.projects.length ? 'Pick a channel on the left to start talking.' : 'Create or join a project first. Each project gets a general channel, a handover channel and as many discussion threads as you need.'}</p>${S.hub.projects.length ? '' : '<button class="primary-button" id="hubNewProject">Create a project</button>'}</div>`; $('#hubNewProject')?.addEventListener('click', () => $('#newProjectBtn')?.click()); return; }
    const isGroup = cur.type === 'group'; const c = isGroup ? channelOf(cur) : null; const p = projectOf(cur); const other = isGroup ? null : person(cur.id); const canWrite = !isGroup || p?.role !== 'viewer';
    const title = isGroup ? `<span class="hub-h-ic ${c?.kind || ''}">${icon(c?.kind === 'handover' ? I.swap : I.hash, 18)}</span><div><h2>${esc(c?.name || 'channel')}<small>${esc(p?.name || '')}</small></h2><p>${esc(c?.topic || 'Discussion thread')}</p></div>` : `${av(other, 36)}<div><h2>${esc(other.name)}</h2><p>${other.username ? `@${esc(other.username)} · ` : ''}Direct message, only the two of you</p></div>`;
    const actions = isGroup ? `${c?.kind === 'thread' && (p?.role === 'owner' || c.createdBy === HC.state.user?.id) ? `<button class="icon-button" data-act="archive" title="Archive this thread" aria-label="Archive this thread">${icon(I.trash)}</button>` : ''}<button class="outline-button btn-sm" data-act="call" data-project="${esc(cur.projectId)}">${icon(I.phone, 14)} Call</button><button class="outline-button btn-sm" data-act="workspace" data-project="${esc(cur.projectId)}">${icon(I.code, 14)} Open workspace</button>` : '';
    main.innerHTML = `<header class="hub-h"><button class="icon-button hub-back" data-act="back" aria-label="Back to channels">${icon(I.back)}</button>${title}<div class="hub-h-actions">${actions}</div></header>
      <div class="hub-msgs" id="hubMsgs" tabindex="0" aria-live="polite"></div><div class="hub-typing" id="hubTyping"></div>
      ${canWrite ? `<form class="hub-compose" id="hubForm"><div class="hub-reply" id="hubReply" hidden></div><div class="hub-compose-box"><textarea id="hubInput" rows="1" maxlength="4000" placeholder="${esc(placeholder())}" aria-label="Message"></textarea><div class="hub-tools"><button type="button" class="hub-tool" data-act="emoji" title="Emoji" aria-label="Emoji">${icon(I.smile, 18)}</button>${isGroup ? `<button type="button" class="hub-tool" data-act="handover" data-project="${esc(cur.projectId)}" title="Leave a handover" aria-label="Leave a handover">${icon(I.swap, 18)}<span>Handover</span></button><button type="button" class="hub-tool ai${S.aiMode ? ' on' : ''}" data-act="ai" title="Ask the shared assistant. Everyone sees the question and the answer." aria-pressed="${S.aiMode}">${icon(I.spark, 18)}<span>Ask AI</span></button>` : ''}<button class="hub-send" title="Send (Enter)" aria-label="Send message">${icon(I.send, 18)}</button></div></div></form>` : '<div class="hub-readonly">You have view-only access to this project.</div>'}`;
    const input = $('#hubInput'); const form = $('#hubForm');
    if (form) {
      const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(160, input.scrollHeight)}px`; };
      let typedAt = 0; input.addEventListener('input', () => { grow(); if (cur.type === 'direct' && Date.now() - typedAt > 3500 && input.value) { typedAt = Date.now(); sdkChannel(cur).sendTypingStatus('RC:TxtMsg').catch(() => {}); } });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } if (e.key === 'Escape' && S.reply) { S.reply = null; paintReply(); } });
      form.addEventListener('submit', async (e) => { e.preventDefault(); let text = input.value; if (!text.trim()) return; let ai = S.aiMode && cur.type === 'group'; const tagged = text.match(/^\s*@ai\b[\s,:]*/i); if (tagged && cur.type === 'group') { ai = true; text = text.slice(tagged[0].length); if (!text.trim()) return; } input.value = ''; grow(); const ok = await sendText(text, { ai }); if (ok === false) { input.value = text; grow(); } if (S.aiMode) { S.aiMode = false; paintMain(); paintMessages({ stick: true }); $('#hubInput')?.focus(); } });
    }
    $('#hubMsgs').addEventListener('scroll', async (e) => { const box = e.currentTarget; if (box.scrollTop < 60 && !box.dataset.busy && S.queries.get(keyOf(cur))?.hasNext) { box.dataset.busy = '1'; const before = box.scrollHeight; try { await loadHistory(cur, { older: true }); paintMessages(); box.scrollTop = box.scrollHeight - before; } finally { delete box.dataset.busy; } } });
    paintMessages({ stick: true }); paintReply();
  }
  const placeholder = () => { const cur = S.current; if (!cur) return ''; if (cur.type === 'direct') return `Message ${person(cur.id).name}`; if (S.aiMode) return 'Ask the shared assistant. Everyone sees the question and the answer.'; const c = channelOf(cur); return c?.kind === 'handover' ? 'Reply here, or use Handover to leave a structured note' : `Message #${c?.name || 'channel'}  ·  start with @ai to ask the assistant`; };
  function paintReply() { const el = $('#hubReply'); if (!el) return; el.hidden = !S.reply; if (S.reply) el.innerHTML = `<span>Replying to <b>${esc(person(S.reply.from).name)}</b>: ${esc(preview(S.reply))}</span><button type="button" class="hub-mini" data-act="unreply" aria-label="Cancel reply">${icon(I.x, 14)}</button>`; }
  function paintTyping() { const el = $('#hubTyping'); if (!el) return; const t = S.typing.get(keyOf(S.current)); el.innerHTML = t ? `<span class="hub-dots"><i></i><i></i><i></i></span>${esc(person(t.who).name)} is typing…` : ''; }

  function handoverCard(msg) {
    const c = msg.content; const acks = (msg.meta.r_check || '').split(',').filter(Boolean); const mine = acks.includes(S.me); const row = (label, cls, text) => (text ? `<div class="ho-row ${cls}"><span>${label}</span><div>${md(text)}</div></div>` : '');
    return `<div class="ho-card"><div class="ho-top"><span class="ho-tag">${icon(I.swap, 14)} Handover</span>${c.to ? `<span class="ho-to">for <b>${esc(c.toName || person(c.to).name)}</b></span>` : '<span class="ho-to">for the whole team</span>'}</div>${row('Done', 'done', c.done)}${row('Next', 'next', c.next)}${row('Blocked', 'blocked', c.blocked)}<div class="ho-foot">${acks.length ? `<span class="ho-acks">${icon(I.check, 14)} Picked up by ${acks.map((u) => esc(u === S.me ? 'you' : person(u).name)).join(', ')}</span>` : '<span class="ho-acks muted">Nobody has picked this up yet</span>'}${msg.from !== S.me ? `<button class="outline-button btn-sm${mine ? ' on' : ''}" data-act="react" data-key="r_check" data-id="${esc(msg.id)}">${mine ? 'Picked up ✓' : 'I’ve got it'}</button>` : ''}</div></div>`;
  }
  function paintMessages({ stick = false } = {}) {
    const box = $('#hubMsgs'); const cur = S.current; if (!box || !cur) return; box.classList.remove('loading'); const key = keyOf(cur); const list = listFor(key); const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    if (!list.length && !S.thinking.has(key)) {
      const c = cur.type === 'group' ? channelOf(cur) : null;
      box.innerHTML = c?.kind === 'handover' ? `<div class="hub-empty in"><div class="hub-empty-ic">${icon(I.swap, 28)}</div><h2>No handovers yet</h2><p>Hackathons run around the clock. Before you sleep, leave a short note: what is done, what is next and what is blocked. Whoever is awake picks it up.</p><button class="primary-button" data-act="handover" data-project="${esc(cur.projectId)}">Leave the first handover</button></div>` : `<div class="hub-empty in"><div class="hub-empty-ic">${icon(cur.type === 'direct' ? I.hub : I.hash, 28)}</div><h2>${cur.type === 'direct' ? `Say hi to ${esc(person(cur.id).name)}` : `This is the start of #${esc(c?.name || '')}`}</h2><p>${cur.type === 'direct' ? 'Messages here are private between the two of you.' : esc(c?.topic || 'Keep one topic per thread so decisions are easy to find later.')}</p></div>`; return;
    }
    let html = S.queries.get(key)?.hasNext ? '<div class="hub-more">Scroll up for earlier messages</div>' : ''; let prev = null; const lastMine = [...list].reverse().find((m) => m.from === S.me);
    for (const msg of list) {
      const day = dayLabel(msg.at); if (!prev || dayLabel(prev.at) !== day) { html += `<div class="hub-day"><span>${day}</span></div>`; prev = null; }
      const who = person(msg.from); const isAi = Boolean(msg.extra.ai) || who.bot; const grouped = prev && prev.from === msg.from && msg.at - prev.at < 5 * 60000 && prev.type !== HANDOVER && msg.type !== HANDOVER && !msg.meta.re;
      let re = null; if (msg.meta.re) { try { re = JSON.parse(msg.meta.re); } catch { re = null; } }
      const chips = REACTIONS.filter(([k]) => msg.type !== HANDOVER || k !== 'r_check').map(([k, e]) => { const users = (msg.meta[k] || '').split(',').filter(Boolean); return users.length ? `<button class="hub-rx${users.includes(S.me) ? ' on' : ''}" data-act="react" data-key="${k}" data-id="${esc(msg.id)}" title="${esc(users.map((u) => (u === S.me ? 'You' : person(u).name)).join(', '))}">${e}<b>${users.length}</b></button>` : ''; }).join('');
      const body = msg.type === HANDOVER ? handoverCard(msg) : msg.type === 'RC:TxtMsg' ? `<div class="hub-text${isAi ? ' ai' : ''}" data-body="${esc(msg.id)}">${md(msg.text)}</div>` : `<div class="hub-text muted">Sent something this version of HackConnect cannot show.</div>`;
      html += `<article class="hub-msg${grouped ? ' grouped' : ''}${msg.from === S.me ? ' mine' : ''}${isAi ? ' from-ai' : ''}" data-mid="${esc(msg.id)}">${grouped ? `<span class="hub-msg-time">${time(msg.at)}</span>` : (isAi ? `<span class="av hub-ai-av" style="--s:34px">${icon(I.spark, 17)}</span>` : av(who, 34))}<div class="hub-msg-b">${grouped ? '' : `<div class="hub-msg-h"><b>${esc(who.name)}</b>${isAi ? `<span class="chip mint">AI${msg.extra.provider ? ` · ${esc(msg.extra.provider)}` : ''}</span>${msg.extra.askedBy ? `<span class="hub-asked">asked by ${esc(msg.extra.askedBy)}</span>` : ''}` : ''}${msg.meta.ai ? `<span class="chip">${icon(I.spark, 11)} asked the assistant</span>` : ''}<time>${time(msg.at)}</time></div>`}${re ? `<div class="hub-quote"><b>${esc(re.name)}</b> ${esc(re.text)}</div>` : ''}${body}${chips ? `<div class="hub-rxs">${chips}</div>` : ''}${cur.type === 'direct' && msg === lastMine && S.seenIds?.has(msg.id) ? '<div class="hub-seen">Seen</div>' : ''}</div><div class="hub-msg-tools"><button data-act="pick" data-id="${esc(msg.id)}" title="React" aria-label="React">${icon(I.smile, 15)}</button><button data-act="reply" data-id="${esc(msg.id)}" title="Reply" aria-label="Reply">${icon(I.reply, 15)}</button></div></article>`;
      prev = msg;
    }
    if (S.thinking.has(key)) html += `<article class="hub-msg from-ai"><span class="av hub-ai-av" style="--s:34px">${icon(I.spark, 17)}</span><div class="hub-msg-b"><div class="hub-msg-h"><b>HackConnect AI</b><span class="chip mint">AI</span></div><div class="hub-text ai"><span class="hub-dots"><i></i><i></i><i></i></span> Reading the project and thinking…</div></div></article>`;
    box.innerHTML = html; if (stick || nearBottom) box.scrollTop = box.scrollHeight; paintTyping();
    for (const id of [...S.animate]) { S.animate.delete(id); const el = $(`[data-body="${CSS.escape(id)}"]`, box); const msg = list.find((m) => m.id === id); if (el && msg) typeOut(el, msg.text, box); }
  }
  /** The assistant's answer types itself out, so the team can read along. */
  function typeOut(el, text, box) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || text.length < 40) return; const total = text.length; const step = Math.max(3, Math.ceil(total / 90)); let at = 0; el.classList.add('typing');
    const tick = () => { if (!el.isConnected) return; at = Math.min(total, at + step); el.innerHTML = md(text.slice(0, at)); if (box.scrollHeight - box.scrollTop - box.clientHeight < 200) box.scrollTop = box.scrollHeight; if (at < total) setTimeout(tick, 28); else el.classList.remove('typing'); };
    tick();
  }
  function paintAside() {
    const aside = $('#hubAside'); if (!aside) return; const cur = S.current; if (!cur) { aside.innerHTML = ''; return; }
    if (cur.type === 'direct') { const u = person(cur.id); const shared = S.hub.projects.filter((p) => p.members.some((m) => m.nx === cur.id)); aside.innerHTML = `<div class="hub-card center">${av(u, 64)}<h3>${esc(u.name)}</h3>${u.username ? `<p class="muted">@${esc(u.username)}</p>` : ''}</div><div class="hub-card"><h4>Projects you share</h4>${shared.map((p) => `<button class="hub-link" data-act="workspace" data-project="${esc(p.id)}">${icon(I.code, 14)} ${esc(p.name)}</button>`).join('') || '<p class="muted small">None yet.</p>'}</div>`; return; }
    const p = projectOf(cur); if (!p) { aside.innerHTML = ''; return; } const ho = p.channels.find((c) => c.kind === 'handover'); const latest = ho ? [...listFor(`group:${ho.id}`)].reverse().find((m) => m.type === HANDOVER) : null;
    if (ho && !S.queries.has(`group:${ho.id}`)) loadHistory({ type: 'group', id: ho.id, projectId: p.id }).then(() => { if (keyOf(S.current) === keyOf(cur)) paintAside(); }).catch(() => {});
    const line = (label, text) => (text ? `<div class="ho-mini-row"><span>${label}</span><p>${esc(text.replace(/\s+/g, ' ').slice(0, 140))}</p></div>` : '');
    aside.innerHTML = `<div class="hub-card"><h4>Latest handover</h4>${latest ? `<div class="ho-mini"><div class="ho-mini-h">${av(person(latest.from), 24)}<b>${esc(person(latest.from).name)}</b><time>${esc(HC.ago(latest.at))}</time></div>${line('Done', latest.content.done)}${line('Next', latest.content.next)}${line('Blocked', latest.content.blocked)}</div><button class="hub-link" data-act="open" data-type="group" data-id="${esc(ho.id)}" data-project="${esc(p.id)}">${icon(I.swap, 14)} Open #handover</button>` : `<p class="muted small">Nobody has left a handover yet.</p>${p.role !== 'viewer' ? `<button class="hub-link" data-act="handover" data-project="${esc(p.id)}">${icon(I.swap, 14)} Leave a handover</button>` : ''}`}</div>
      <div class="hub-card"><h4>On this project <span class="muted">${p.members.length}</span></h4>${p.members.map((m) => { const u = person(m.nx); return `<div class="hub-member">${av(u, 28)}<div><b>${esc(u.name)}${m.nx === S.me ? ' <span class="muted">(you)</span>' : ''}</b><span>${esc(m.role)}</span></div>${m.nx !== S.me ? `<button class="hub-mini" data-act="open" data-type="direct" data-id="${esc(m.nx)}" title="Message ${esc(u.name)}" aria-label="Message ${esc(u.name)}">${icon(I.hub, 14)}</button>` : ''}</div>`; }).join('')}</div>`;
  }

  function popover(anchor, html, onPick) {
    $('#hubPop')?.remove(); const p = document.createElement('div'); p.id = 'hubPop'; p.className = 'hub-pop'; p.innerHTML = html; document.body.appendChild(p); const r = anchor.getBoundingClientRect(); p.style.left = `${Math.max(8, Math.min(innerWidth - p.offsetWidth - 8, r.left + r.width / 2 - p.offsetWidth / 2))}px`; p.style.top = `${r.top - p.offsetHeight - 8 > 8 ? r.top - p.offsetHeight - 8 : r.bottom + 8}px`;
    const close = () => { p.remove(); document.removeEventListener('pointerdown', outside, true); }; const outside = (e) => { if (!p.contains(e.target)) close(); }; setTimeout(() => document.addEventListener('pointerdown', outside, true));
    p.addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (b) { onPick(b.dataset.v); close(); } });
  }
  function onClick(e) {
    const t = e.target.closest('[data-act]'); if (!t) return; const act = t.dataset.act; const find = (id) => listFor(keyOf(S.current)).find((m) => m.id === id);
    if (act === 'open') return open({ type: t.dataset.type, id: t.dataset.id, projectId: t.dataset.project });
    if (act === 'thread') return newThread(t.dataset.project);
    if (act === 'handover') return handoverForm(t.dataset.project);
    if (act === 'archive') return archive(S.current);
    if (act === 'workspace') return HC.openProject(t.dataset.project);
    if (act === 'call') return HC.call?.join ? HC.call.join(t.dataset.project, 'General') : HC.openProject(t.dataset.project);
    if (act === 'back') { S.current = null; return render(); }
    if (act === 'ai') { S.aiMode = !S.aiMode; t.classList.toggle('on', S.aiMode); t.setAttribute('aria-pressed', S.aiMode); const input = $('#hubInput'); input.placeholder = placeholder(); input.focus(); $('.hub-compose-box')?.classList.toggle('ai', S.aiMode); return; }
    if (act === 'emoji') return popover(t, `<div class="hub-pop-grid">${EMOJI.map((x) => `<button type="button" data-v="${x}">${x}</button>`).join('')}</div>`, (v) => { const input = $('#hubInput'); const at = input.selectionStart ?? input.value.length; input.value = input.value.slice(0, at) + v + input.value.slice(at); input.focus(); input.setSelectionRange(at + v.length, at + v.length); });
    if (act === 'pick') { const msg = find(t.dataset.id); if (msg) popover(t, `<div class="hub-pop-grid quick">${REACTIONS.filter(([k]) => msg.type !== HANDOVER || k !== 'r_check').map(([k, x]) => `<button type="button" data-v="${k}">${x}</button>`).join('')}</div>`, (k) => react(msg, k)); return; }
    if (act === 'react') { const msg = find(t.dataset.id); if (msg) react(msg, t.dataset.key); return; }
    if (act === 'reply') { S.reply = find(t.dataset.id) || null; paintReply(); $('#hubInput')?.focus(); return; }
    if (act === 'unreply') { S.reply = null; paintReply(); }
  }

  // ---------- public entry points ----------
  HC.openHub = async ({ projectId, channel = 'general', user } = {}) => {
    ensureView(); show(); if (!S.ready) await start(); if (!S.ready) return;
    if (user) { const nx = Object.values(S.hub.people).find((u) => u.id === user || u.username === user)?.nx; if (nx) return open({ type: 'direct', id: nx }); return; }
    if (projectId) { let p = S.hub.projects.find((x) => x.id === projectId); if (!p) { await loadHub(); p = S.hub.projects.find((x) => x.id === projectId); } const c = p?.channels.find((x) => x.key === channel || x.id === channel) || p?.channels[0]; if (c) open({ type: 'group', id: c.id, projectId: p.id }); }
  };

  // In the live workspace, the room chat gets a shortcut to the project's channels.
  new MutationObserver(() => {
    const pane = $('#paneChat'); if (!pane || !S.enabled || $('.ws-hub-bar', pane)) return;
    const bar = document.createElement('div'); bar.className = 'ws-hub-bar'; bar.innerHTML = '<span>Threads, handovers and direct messages live in the team hub.</span><button type="button" class="outline-button btn-sm">Open team hub</button>';
    bar.querySelector('button').addEventListener('click', () => HC.openHub({ projectId: HC.state.currentProject?.id })); pane.prepend(bar);
  }).observe(document.body, { childList: true, subtree: true });

  ensureView();
  const boot = setInterval(() => { if (HC.state?.user) { clearInterval(boot); start(); } }, 500);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.ready && S.current && isVisible()) markRead(S.current); });
})();
