/* Team hub, built on the Nexconn ChatUI SDK (@nexconn/chatui).
   - The conversation list, messages, input, replies, forwarding, images, files, emoji, read receipts and typing state are
     Nexconn's own <nc-chat-ui-app-provider> web components.
   - HackConnect adds what makes it a hackathon tool: every project gets #general and #handover, anyone can start a topic
     thread, teammates can be messaged directly, the shared AI answers in the channel for the whole team (/ai …), and a
     structured "handover" message type for shift changes.
   The server (lib/nexconn.mjs) issues each person's Nexconn token and keeps channel membership equal to project membership.
   The SDK bundle (window.HCNex, /vendor/nexconn-client.js) is loaded on demand. Builds on window.HC (exposed by app.js). */
(() => {
  const HC = window.HC; if (!HC) return;
  const { api, esc, notify, modal, confirmBox, avColor } = HC;
  const $ = (s, r = document) => r.querySelector(s); const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const icon = (d, size = 16) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const I = {
    hub: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/>', hash: '<path d="M5 9h14M5 15h14M10 4L8 20M16 4l-2 16"/>', swap: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
    code: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4"/>', phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z"/>', video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/>', trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>', chat: '<path d="M5 5h14v10H10l-5 4z"/>',
  };
  const HANDOVER = 'HC:Handover';
  /** Small SVG pictures handed to ChatUI as image URLs (it renders avatars and header buttons with <img>). */
  const svgUrl = (inner, bg = 'none') => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">${bg !== 'none' ? `<rect width="40" height="40" rx="20" fill="${bg}"/>` : ''}${inner}</svg>`)}`;
  const initialsAvatar = (name, seed) => svgUrl(`<text x="20" y="25.5" text-anchor="middle" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="15" font-weight="700" fill="#14200e">${esc(String(name || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?')}</text>`, avColor(seed || name || '?'));
  const glyph = (d, fill = '#14200e', bg = '#b9f07c') => svgUrl(`<g transform="translate(8 8) scale(1)" fill="none" stroke="${fill}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d}</g>`, bg);
  const button = (d) => svgUrl(`<g transform="translate(8 8)" fill="none" stroke="#41464F" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d}</g>`);
  const AVATAR = { bot: glyph(I.spark), general: glyph(I.hash), handover: glyph(I.swap, '#14200e', '#f6a96c'), thread: glyph(I.chat, '#14200e', '#7db7e8') };

  const S = { status: 'idle', error: '', session: null, hub: { projects: [], people: {} }, C: null, U: null, app: null, current: null, unread: 0, lastHubLoad: 0 };
  HC.hub = S;
  HC.nxProfile = (nx) => userProfile(nx); // names for the call window (nx-call.js)
  const person = (nx) => S.hub.people[nx];
  const channelIndex = () => { const map = new Map(); for (const p of S.hub.projects) for (const c of p.channels) map.set(c.id, { project: p, channel: c }); return map; };
  const findChannel = (id) => channelIndex().get(id);

  // ---------- page + nav ----------
  function ensureView() {
    if (!$('.nav button[data-view="hub"]')) {
      const b = document.createElement('button'); b.dataset.view = 'hub'; b.innerHTML = `<span class="nav-icon">${icon(I.hub, 17)}</span><span>Team hub</span><span class="nav-count" id="hubCount" hidden>0</span>`;
      const anchor = $('.nav button[data-view="workspace"]'); anchor ? anchor.after(b) : $('.nav')?.appendChild(b); b.addEventListener('click', show);
    }
    if (!$('#hubView')) { const s = document.createElement('section'); s.className = 'view'; s.id = 'hubView'; $('.content')?.appendChild(s); }
  }
  function show() {
    ensureView(); $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'hubView')); $$('.nav button[data-view]').forEach((x) => x.classList.toggle('active', x.dataset.view === 'hub')); const c = $('#crumbPage'); if (c) c.textContent = 'Team hub';
    if (S.status === 'idle' || S.status === 'error') start(); else if (S.status === 'ready') { if (Date.now() - S.lastHubLoad > 3000) loadHub().then(paintSide).catch(() => {}); fit(); }
    render();
  }
  const isVisible = () => $('#hubView')?.classList.contains('active') && !document.hidden;

  function render() {
    const view = $('#hubView'); if (!view) return;
    if (S.status === 'off') { view.innerHTML = `<div class="hub-empty"><div class="hub-empty-ic">${icon(I.hub, 30)}</div><h2>Team hub is not switched on</h2><p>Project channels, threads, handovers and direct messages run on Nexconn. An administrator adds <code>NEXCONN_KEY</code> and <code>NEXCONN_SECRET</code> to the server to turn it on.</p></div>`; return; }
    if (S.status === 'error') { view.innerHTML = `<div class="hub-empty"><div class="hub-empty-ic">${icon(I.hub, 30)}</div><h2>Could not connect to team messaging</h2><p>${esc(S.error)}</p><button class="primary-button" id="hubRetry">Try again</button></div>`; $('#hubRetry').addEventListener('click', () => { S.status = 'idle'; show(); }); return; }
    if (S.status !== 'ready') { if (!$('.hub-loading', view)) view.innerHTML = `<div class="hub-empty hub-loading"><div class="hub-empty-ic spin">${icon(I.hub, 30)}</div><h2>Connecting to your team…</h2><p>Setting up your project channels.</p></div>`; return; }
    if (!$('#hubChat', view)) { // the ChatUI element is created once and kept: re-creating it would drop the open conversation
      view.innerHTML = `<div class="page-heading hub-heading"><div><h1>Team hub</h1><p>Every project gets <b>#general</b> and <b>#handover</b>. Start a thread for a topic, message a teammate, or type <code>/ai</code> to ask the assistant for the whole team.</p></div><div class="heading-actions"><button class="outline-button" id="hubDm">${icon(I.chat, 14)} Message a teammate</button><button class="primary-button" id="hubThread">${icon(I.plus, 14)} New thread</button></div></div>
        <div class="hub-wrap"><div class="hub"><aside class="hub-side" id="hubSide" aria-label="Projects and people"></aside><div class="hub-chat" id="hubChat"></div></div></div>`;
      $('#hubChat', view).appendChild(document.createElement('nc-chat-ui-app-provider'));
      $('#hubThread', view).addEventListener('click', () => newThread()); $('#hubDm', view).addEventListener('click', pickTeammate);
    }
    paintSide(); fit();
  }
  function fit() { const hub = $('.hub'); if (!hub || !$('#hubView')?.classList.contains('active')) return; hub.style.height = `${Math.max(480, innerHeight - (hub.getBoundingClientRect().top + scrollY) - 28)}px`; }
  addEventListener('resize', fit);

  function paintSide() {
    const side = $('#hubSide'); if (!side) return; const cur = S.current;
    const projects = S.hub.projects;
    side.innerHTML = projects.length ? projects.map((p) => `<div class="hub-proj"><div class="hub-proj-head"><b title="${esc(p.name)}">${esc(p.name)}</b>${p.role !== 'viewer' ? `<button class="hub-mini" data-thread="${esc(p.id)}" title="Start a thread in ${esc(p.name)}" aria-label="Start a thread in ${esc(p.name)}">${icon(I.plus, 13)}</button>` : ''}</div>
      ${p.ready ? '' : '<div class="hub-warn">Channels are still being set up. Refresh in a moment.</div>'}
      ${p.channels.map((c) => `<button class="hub-ch ${cur?.type === 'group' && cur.id === c.id ? 'on' : ''}" data-open-group="${esc(c.id)}"><span class="hub-ch-ic k-${c.kind}">${icon(c.kind === 'handover' ? I.swap : I.hash, 13)}</span><span>${esc(c.name)}</span></button>`).join('')}
      <div class="hub-people">${p.members.filter((m) => m.nx !== S.hub.me).map((m) => { const who = person(m.nx) || { name: 'Teammate' }; return `<button class="hub-person ${cur?.type === 'direct' && cur.id === m.nx ? 'on' : ''}" data-open-direct="${esc(m.nx)}" title="Message ${esc(who.name)}">${HC.av(who, 20)}<span>${esc(who.name)}</span></button>`; }).join('') || '<span class="hub-muted">Invite teammates to this project to chat with them.</span>'}</div></div>`).join('')
      : `<div class="hub-muted hub-pad">You are not in a project yet. Create or join one and its channels show up here.</div>`;
    $$('[data-open-group]', side).forEach((b) => b.addEventListener('click', () => openGroup(b.dataset.openGroup)));
    $$('[data-open-direct]', side).forEach((b) => b.addEventListener('click', () => openDirect(b.dataset.openDirect)));
    $$('[data-thread]', side).forEach((b) => b.addEventListener('click', () => newThread(b.dataset.thread)));
  }
  function paintBadge() { const c = $('#hubCount'); if (c) { c.textContent = S.unread > 99 ? '99+' : String(S.unread); c.hidden = !S.unread; } }

  // ---------- data ----------
  async function loadHub() { const hub = await api('/hub'); S.hub = hub; S.lastHubLoad = Date.now(); return hub; }
  let refreshing = null; const refreshHub = () => (refreshing ||= loadHub().finally(() => { refreshing = null; }));
  const loadSdk = () => (window.HCNex ? Promise.resolve() : new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = '/vendor/nexconn-client.js'; s.onload = resolve; s.onerror = () => reject(new Error('Could not load the messaging SDK. Check your connection and try again.')); document.head.appendChild(s); }));

  /** Profiles ChatUI asks for. Everything comes from HackConnect, so names and avatars match the rest of the app. */
  const userProfile = (nx) => { const p = person(nx); if (nx === S.session?.bot?.id) return { userId: nx, name: S.session.bot.name, avatarUrl: AVATAR.bot }; return { userId: nx, name: p?.name || 'Former teammate', avatarUrl: p?.avatar || initialsAvatar(p?.name || '?', p?.username || p?.name || nx) }; };
  const groupProfile = (id) => { const hit = findChannel(id); if (!hit) return { groupId: id, name: 'Archived thread', avatarUrl: AVATAR.thread, memberCount: 0 }; return { groupId: id, name: `#${hit.channel.name} · ${hit.project.name}`, avatarUrl: AVATAR[hit.channel.kind] || AVATAR.thread, memberCount: hit.project.members.length }; };
  const hooks = {
    async reqUserProfiles(ids) {
      const missing = ids.filter((id) => !person(id) && id !== S.session?.bot?.id);
      if (missing.length) { try { const { people } = await api('/hub/people', { method: 'POST', body: JSON.stringify({ ids: missing }) }); for (const p of people) S.hub.people[p.nx] ||= { nx: p.nx, name: p.name, avatar: p.avatar }; } catch (error) { console.error(error); } }
      return ids.map(userProfile);
    },
    async reqGroupProfiles(ids) { if (ids.some((id) => !findChannel(id))) await refreshHub().catch(() => {}); return ids.map(groupProfile); },
    async reqSystemProfiles(ids) { return ids.map((id) => ({ systemId: id, name: 'HackConnect', avatarUrl: AVATAR.bot })); },
    // ChatUI names and pictures message senders from this list, so the assistant (which posts but is not a member) is included.
    async reqGroupMembers(groupId) { if (!findChannel(groupId)) await refreshHub().catch(() => {}); const hit = findChannel(groupId); return [...(hit?.project.members || []).map((m) => ({ userId: m.nx })), ...(S.session?.bot ? [{ userId: S.session.bot.id }] : [])]; },
    getDefaultUserProfile: (id) => userProfile(id),
    getDefaultGroupProfile: (id) => groupProfile(id),
  };

  // ---------- the handover message: done / next / blocked, rendered as a card inside the conversation ----------
  class HandoverMessage extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); }
    set message(model) { this._m = model; this.paint(); } get message() { return this._m; }
    connectedCallback() { this.paint(); }
    paint() {
      const c = this._m?.content || {}; const row = (label, text, tone) => (String(text || '').trim() ? `<div class="r ${tone}"><b>${label}</b><p>${esc(text)}</p></div>` : '');
      this.shadowRoot.innerHTML = `<style>:host{display:block;max-width:420px}.card{border:1px solid #f3c79e;border-radius:12px;background:#fffaf5;padding:10px 12px;font:13px/1.45 Inter,Segoe UI,system-ui,sans-serif;color:#020814}.h{display:flex;gap:6px;align-items:center;font-weight:700;color:#a85a1b;font-size:12px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}.r{border-left:3px solid #d8dde6;padding:2px 0 2px 9px;margin-top:7px}.r b{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#41464F}.r p{margin:2px 0 0;white-space:pre-wrap;word-break:break-word}.done{border-color:#7fc94a}.next{border-color:#5d9be0}.blocked{border-color:#e2685f}.f{margin-top:8px;color:#7C838E;font-size:11px}</style>
        <div class="card"><div class="h">⇄ Handover${c.until ? ` · back ${esc(c.until)}` : ''}</div>${row('Done', c.done, 'done')}${row('Next up', c.next, 'next')}${row('Blocked on', c.blocked, 'blocked')}${c.by ? `<div class="f">From ${esc(c.by)}</div>` : ''}</div>`;
    }
  }

  // ---------- start: SDK, ChatUI, connection ----------
  async function start() {
    if (S.status === 'loading' || S.status === 'ready' || !HC.state.user) return; S.status = 'loading'; S.error = ''; render();
    try {
      const session = await api('/nexconn/session'); if (!session.enabled) { S.status = 'off'; render(); return; }
      S.session = session; await Promise.all([loadSdk(), loadHub()]);
      const C = S.C = window.HCNex.chat; const U = S.U = window.HCNex.chatui;
      if (!S.app) {
        window.HCNex.call?.NCCallEngine?.install(); // the Call SDK plugs into the chat engine, so it must be installed first
        C.NCEngine.initialize({ appKey: session.appKey, areaCode: session.areaCode || C.AreaCode.SG, logLevel: C.LogLevel?.WARN });
        const app = U.NCChatUIApplication.initialize({ hooks, language: 'en_US', allowedToRecallTime: 300 }); if (!app) throw new Error('The chat interface could not start in this browser.');
        S.app = app; configure(app); app.ready();
        C.NCEngine.addMessageHandler('hc-hub', new C.MessageHandler({ onMessageReceived: ({ messages }) => onIncoming(messages || []) }));
      }
      const result = await C.NCEngine.connect({ token: session.token });
      if (!result.isOk) throw new Error(`Messaging sign-in was refused (code ${result.code}). Try again in a moment.`);
      S.status = 'ready'; render(); countUnread();
      const remembered = (() => { try { return JSON.parse(localStorage.getItem('hc.hub.current') || 'null'); } catch { return null; } })();
      if (remembered?.type === 'group' && findChannel(remembered.id)) openGroup(remembered.id, false);
    } catch (error) { console.error(error); S.status = 'error'; S.error = error.message || 'Unknown error'; render(); }
  }

  function configure(app) {
    const U = S.U; const C = S.C;
    // registerLanguagePack replaces the whole pack, so start from the built-in English entries and change a few lines.
    app.registerLanguagePack('en_US', { ...(app.cloneLanguageEntries('en_US') || {}), 'channel.list.bar.title': 'Conversations', 'channel.list.empty.desc': 'No conversations yet. Open a project channel or a teammate.', 'channel.empty.desc': 'Pick a channel or a teammate to start talking.', 'input.placeholder': 'Message… start with /ai to ask the assistant' });
    app.setCommandSwitch(U.ChatUICommand.PROMPT_SENDER_WHEN_QUOTE_MESSAGE, true);
    app.setMessageBubbleConfig({ layout: U.BubbleLayout.LEFT_RIGHT, redius: 12, backgroundColorForMyself: 0xd9f5bc, textColorForMyself: 0x14200e, backgroundColorForOthers: 0xf3f5fa, textColorForOthers: 0x020814, showOthersNameInGroupChannel: true, showOthersProfileInGroupChannel: true, showOthersProfileInDirectionChannel: true });
    app.setChannelsItemConfig({ radius: 10, portraitSize: 'small', topBackgroundColor: 0xf4faec, hoverBackgroundColor: 0xf3f5fa, activeBackgroundColor: 0xe3f5cf });
    app.registerCustomMessages([{ messageType: HANDOVER, isPersisted: true, isCounted: true, digest: (m) => `[Handover]${m.content?.next ? ` Next: ${String(m.content.next).slice(0, 60)}` : ''}`, component: { tagName: 'handover', elementClass: HandoverMessage } }]);
    const group = (m) => m.channelType === C.ChannelType.GROUP && Boolean(findChannel(m.channelId));
    const callable = (m) => m.channelType === C.ChannelType.DIRECT ? m.channelId !== S.session?.bot?.id : group(m);
    app.setChannelPanelExtensions([
      { id: 'hc-call', icon: button(I.phone), filter: callable },
      { id: 'hc-ai', icon: button(I.spark), filter: group },
      { id: 'hc-handover', icon: button(I.swap), filter: group },
      { id: 'hc-workspace', icon: button(I.code), filter: group },
      { id: 'hc-archive', icon: button(I.trash), filter: (m) => { const hit = group(m) && findChannel(m.channelId); return Boolean(hit && hit.channel.kind === 'thread' && (hit.project.role === 'owner' || hit.channel.createdBy === HC.state.user?.id)); } },
    ]);
    app.addEventListener(U.ChatUIEvents.CHANNEL_PANEL_EXTENSION_TOUCH, (event) => {
      const model = event.data.channelModel; const id = model.channelId;
      if (event.data.id === 'hc-call') { if (!HC.nxCall) return notify('Calls are not available in this build'); if (model.channelType === C.ChannelType.DIRECT) HC.nxCall.open({ kind: 'direct', userId: id }); else { const h = findChannel(id); if (h) HC.nxCall.open({ kind: 'group', projectId: h.project.id, channelId: id, title: `#${h.channel.name} · ${h.project.name}` }); } return; }
      const hit = findChannel(id); if (!hit) return;
      if (event.data.id === 'hc-ai') askAi(hit);
      else if (event.data.id === 'hc-handover') writeHandover(hit);
      else if (event.data.id === 'hc-workspace') HC.openProject(hit.project.id);
      else if (event.data.id === 'hc-archive') archive(hit);
    });
    app.addEventListener(U.ChatUIEvents.CHANNEL_SELECTED, (event) => {
      const m = event.data.model; S.current = m ? { type: m.channelType === C.ChannelType.GROUP ? 'group' : 'direct', id: m.channelId } : null;
      try { localStorage.setItem('hc.hub.current', JSON.stringify(S.current)); } catch { /* private mode */ }
      paintSide(); setTimeout(countUnread, 800);
    });
    // "/ai question" in a project channel: the question is sent as a normal message (so everyone sees it), then the assistant answers in the channel.
    app.addEventListener(U.ChatUIEvents.MESSAGE_WILL_SEND, (event) => {
      const { channelIdentifier, params } = event.data; const text = String(params?.content?.text || '');
      const match = /^\/ai\b\s*([\s\S]*)$/i.exec(text.trim()); if (!match) return;
      const hit = channelIdentifier.channelType === C.ChannelType.GROUP && findChannel(channelIdentifier.channelId);
      if (!hit) { notify('The assistant answers in project channels. Open a project channel and try again.'); return; }
      if (!match[1].trim()) { notify('Add your question after /ai, for example: /ai how should we split the API work?'); return; }
      setTimeout(() => ask(hit, match[1].trim()), 250);
    });
    app.addEventListener(U.ChatUIEvents.MESSAGE_LINK_CLICK, (event) => { const { type, address } = event.data; if (type === 'url' || /^https?:/i.test(address)) { event.preventDefault?.(); window.open(/^https?:/i.test(address) ? address : `https://${address}`, '_blank', 'noopener,noreferrer'); } });
  }

  let lastToast = 0;
  function onIncoming(messages) {
    let fresh = false; const hub = channelIndex();
    for (const m of messages) {
      const where0 = m.channelIdentifier; const group = where0?.channelType === S.C.ChannelType.GROUP;
      if (group && where0.channelId === WS.channelId) wsAppend(m);
      if (m.senderUserId === S.hub.me) continue; fresh = true;
      if (group && !hub.has(where0.channelId)) refreshHub().then(paintSide).catch(() => {}); // a thread someone just started
      const shownInWorkspace = group && where0.channelId === WS.channelId && $('#workspaceView')?.classList.contains('active');
      if (!isVisible() && !shownInWorkspace && Date.now() - lastToast > 4000) { lastToast = Date.now(); const who = userProfile(m.senderUserId).name; const where = group ? ` in #${hub.get(where0.channelId)?.channel.name || 'a channel'}` : ''; const text = m.messageType === HANDOVER ? 'left a handover' : String(m.content?.text || 'sent a message').slice(0, 80); notify(`${who}${where}: ${text}`); }
    }
    if (fresh) countUnread();
  }
  async function countUnread() { try { const r = await S.C.BaseChannel.getTotalUnreadCount(); if (r.isOk) { S.unread = r.data || 0; paintBadge(); } } catch (error) { console.error(error); } }
  setInterval(() => { if (S.status === 'ready') countUnread(); }, 30000);

  // ---------- actions ----------
  /** Right after connecting, ChatUI is still syncing its channel list and can refuse to open a channel; retry briefly instead of ignoring the click. */
  async function openChannel(identifier, focus, what) {
    if (!S.app) return; for (let attempt = 0; attempt < 8; attempt++) { const r = await S.app.openChannel(identifier, focus).catch(() => ({ isOk: false })); if (!r || r.isOk !== false) return; await new Promise((ok) => setTimeout(ok, 500)); }
    notify(`Could not open that ${what}. Try again.`);
  }
  const openGroup = (id, focus = true) => openChannel(new S.C.GroupChannelIdentifier(id), focus, 'channel');
  const openDirect = (nx) => openChannel(new S.C.DirectChannelIdentifier(nx), true, 'conversation');

  function projectChoices(selected) { const writable = S.hub.projects.filter((p) => p.role !== 'viewer'); return writable.map((p) => `<option value="${esc(p.id)}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}</option>`).join(''); }
  function newThread(projectId) {
    const current = S.current?.type === 'group' ? findChannel(S.current.id)?.project.id : null; const pick = projectId || current || S.hub.projects.find((p) => p.role !== 'viewer')?.id;
    if (!pick) { notify('Join or create a project first. Threads live inside a project.'); return; }
    const m = modal({ title: 'Start a thread', sub: 'A thread is a channel for one topic, such as api-design or demo-script. Everyone on the project is in it.', width: 460,
      body: `<label class="hc-field">Project<select class="inp" id="thProject">${projectChoices(pick)}</select></label><label class="hc-field">Name<input class="inp" id="thName" autofocus autocomplete="off" placeholder="api-design" maxlength="40"></label><label class="hc-field">What is it for? (optional)<input class="inp" id="thTopic" autocomplete="off" maxlength="200" placeholder="Agree the endpoints before Saturday"></label>`,
      actions: [{ label: 'Cancel' }, { label: 'Create thread', kind: 'primary', id: 'ok', onClick: async () => {
        const pid = m.$('#thProject').value; const name = m.$('#thName').value.trim(); if (!name) { notify('Give the thread a name'); return false; }
        const channel = await api(`/projects/${encodeURIComponent(pid)}/channels`, { method: 'POST', body: JSON.stringify({ name, topic: m.$('#thTopic').value.trim() }) });
        await loadHub(); paintSide(); await openGroup(channel.id); notify(`#${channel.name} is ready`);
      } }] });
    m.$('#thName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); m.$('[data-act=ok]').click(); } });
  }
  function pickTeammate() {
    const people = Object.values(S.hub.people).filter((p) => p.nx !== S.hub.me && !p.bot).sort((a, b) => a.name.localeCompare(b.name));
    if (!people.length) { notify('No teammates yet. Invite people to a project or connect with them first.'); return; }
    const m = modal({ title: 'Message a teammate', sub: 'People from your projects and your connections.', width: 440, body: `<input class="inp" id="dmFilter" placeholder="Search by name" autocomplete="off" autofocus><div class="hub-pick" id="dmList">${people.map((p) => `<button class="hub-person" data-nx="${esc(p.nx)}">${HC.av(p, 24)}<span>${esc(p.name)}${p.username ? ` <small>@${esc(p.username)}</small>` : ''}</span></button>`).join('')}</div>`, actions: [{ label: 'Close' }] });
    m.$('#dmFilter').addEventListener('input', (e) => { const q = e.target.value.toLowerCase(); m.$$('[data-nx]').forEach((b) => { b.hidden = !b.textContent.toLowerCase().includes(q); }); });
    m.$$('[data-nx]').forEach((b) => b.addEventListener('click', () => { m.close(); openDirect(b.dataset.nx); }));
  }
  async function ask(hit, question) {
    notify('The assistant is thinking. Its answer will appear in the channel for everyone.');
    try { await api(`/projects/${encodeURIComponent(hit.project.id)}/channels/${encodeURIComponent(hit.channel.id)}/ask`, { method: 'POST', body: JSON.stringify({ prompt: question }) }); } catch (error) { notify(error.message); }
  }
  async function askAi(hit) {
    const question = await HC.ask('Ask the assistant', `Asked in ${hit.project.name} · #${hit.channel.name}. Everyone in the channel sees the question and the answer.`, '', { placeholder: 'How should we split the remaining work?', confirm: 'Ask', multiline: true });
    if (!question) return;
    const sent = await S.app.sendMessage(new S.C.GroupChannelIdentifier(hit.channel.id), new S.C.SendTextMessageParams({ text: `/ai ${question}` }));
    if (sent && sent.isOk === false) notify('Your question could not be sent. Check your connection.');
    // The MESSAGE_WILL_SEND listener sees this "/ai …" message too and asks the assistant, exactly as if it had been typed.
  }
  function writeHandover(hit) {
    const m = modal({ title: 'Leave a handover', sub: `Posted in ${esc(hit.project.name)} · #${esc(hit.channel.name)} so whoever picks up next knows where things stand.`, width: 520,
      body: `<label class="hc-field">Done<textarea class="inp" id="hoDone" rows="3" autofocus placeholder="Login flow works end to end; API deployed to staging"></textarea></label><label class="hc-field">Next up<textarea class="inp" id="hoNext" rows="3" placeholder="Wire the leaderboard to the live API"></textarea></label><label class="hc-field">Blocked on<textarea class="inp" id="hoBlocked" rows="2" placeholder="Nothing / waiting for the judging rubric"></textarea></label><label class="hc-field">Back around (optional)<input class="inp" id="hoUntil" maxlength="40" placeholder="9am IST"></label>`,
      actions: [{ label: 'Cancel' }, { label: 'Post handover', kind: 'primary', onClick: async () => {
        const content = { done: m.$('#hoDone').value.trim().slice(0, 2000), next: m.$('#hoNext').value.trim().slice(0, 2000), blocked: m.$('#hoBlocked').value.trim().slice(0, 1000), until: m.$('#hoUntil').value.trim().slice(0, 40), by: HC.state.user?.name || '' };
        if (!content.done && !content.next && !content.blocked) { notify('Write at least one line'); return false; }
        const r = await S.app.sendMessage(new S.C.GroupChannelIdentifier(hit.channel.id), new S.C.SendMessageParams(content, HANDOVER));
        if (r && r.isOk === false) { notify(`Handover not sent (${r.code}). Try again.`); return false; }
        notify('Handover posted');
      } }] });
  }
  async function archive(hit) {
    if (!await confirmBox('Archive thread', `Archive #${hit.channel.name} in ${hit.project.name}? Its messages are removed for everyone.`, { confirm: 'Archive', danger: true })) return;
    try { await api(`/projects/${encodeURIComponent(hit.project.id)}/channels/${encodeURIComponent(hit.channel.id)}`, { method: 'DELETE' }); await S.app.deleteChannel(new S.C.GroupChannelIdentifier(hit.channel.id)).catch(() => {}); await loadHub(); paintSide(); notify(`#${hit.channel.name} archived`); } catch (error) { notify(error.message); }
  }

  // ---------- workspace chat: the Live workspace's chat pane is the project's #general on Nexconn ----------
  const WS = { projectId: null, channelId: null, seen: new Set() };
  const whenSettled = () => new Promise((resolve) => { const t0 = Date.now(); const tick = () => { if (['ready', 'off', 'error'].includes(S.status) || Date.now() - t0 > 45000) resolve(S.status === 'ready'); else setTimeout(tick, 200); }; if (S.status === 'idle') start(); tick(); });
  const wsText = (m) => {
    const c = m.content || {}; const t = m.messageType;
    if (t === HANDOVER) return `⇄ Handover${c.next ? ` · next: ${c.next}` : ''}${c.blocked ? ` · blocked on: ${c.blocked}` : ''}`;
    if (t === 'RC:TxtMsg' || typeof c.text === 'string') return String(c.text || '');
    if (t === 'RC:ImgMsg' || t === 'RC:GIFMsg') return '📷 Sent an image (open the Team hub to view it)';
    if (t === 'RC:FileMsg') return `📎 ${c.name || 'Sent a file'} (open the Team hub to download it)`;
    if (t === 'RC:HQVCMsg' || t === 'RC:VcMsg') return '🎙 Sent a voice message (open the Team hub to play it)';
    if (t === 'RC:ReferenceMsg') return String(c.text || c.content || '');
    return '';
  };
  const wsMarkup = (m) => { const text = wsText(m); if (!text) return ''; const who = m.senderUserId === S.hub.me ? (HC.state.user?.name || 'You') : userProfile(m.senderUserId).name; const bot = m.senderUserId === S.session?.bot?.id;
    return `<div class="message nx-msg ${bot ? 'is-bot' : ''}" data-message-id="${esc(m.messageId)}"><b>${esc(who)}</b><time>${new Date(m.sentTime || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time><p>${esc(text)}</p></div>`; };
  function wsAppend(m) {
    if (!m?.messageId || WS.seen.has(m.messageId)) return; WS.seen.add(m.messageId); const target = $('#messages'); if (!target) return;
    const html = wsMarkup(m); if (!html) return; const stick = target.scrollHeight - target.scrollTop - target.clientHeight < 80; target.insertAdjacentHTML('beforeend', html); if (stick || m.senderUserId === S.hub.me) target.scrollTop = target.scrollHeight;
    if (m.senderUserId !== S.hub.me) HC.bumpChat?.();
  }
  HC.nxChat = {
    /** True while Nexconn is (or may become) the project chat; false once we know the server has no Nexconn keys. */
    wanted: () => S.status !== 'off' && S.status !== 'error',
    async attach(projectId, fallback) {
      WS.projectId = projectId; WS.channelId = null; WS.seen = new Set();
      const target = $('#messages'); if (target) target.innerHTML = '<div class="nx-note">Connecting to the team chat…</div>';
      if (!await whenSettled()) { fallback?.(); return; } if (WS.projectId !== projectId) return;
      let hit = S.hub.projects.find((p) => p.id === projectId); if (!hit || !hit.channels.some((c) => c.key === 'general')) { await refreshHub().catch(() => {}); hit = S.hub.projects.find((p) => p.id === projectId); }
      const general = hit?.channels.find((c) => c.key === 'general'); const box = $('#messages'); if (!box) return;
      if (!general) { box.innerHTML = '<div class="nx-note">The team chat for this project is still being set up. Try again in a moment.</div>'; return; }
      WS.channelId = general.id;
      box.innerHTML = `<div class="nx-note">This is <b>#general</b> on Nexconn, the same conversation as in the <a href="#" data-nx-hub>Team hub</a>. Type <code>/ai</code> to ask the assistant.</div>`;
      box.querySelector('[data-nx-hub]')?.addEventListener('click', (e) => { e.preventDefault(); HC.openHub?.(projectId); });
      try {
        const query = S.C.BaseChannel.createMessagesQuery({ channelIdentifier: new S.C.GroupChannelIdentifier(general.id), startTime: 0, pageSize: 50, isAscending: false });
        const r = await query.loadNextPage(); if (WS.channelId !== general.id) return;
        const list = (r.data?.data || []).slice().sort((a, b) => a.sentTime - b.sentTime);
        for (const m of list) { WS.seen.add(m.messageId); const html = wsMarkup(m); if (html) box.insertAdjacentHTML('beforeend', html); }
        box.scrollTop = box.scrollHeight;
      } catch (error) { console.error(error); box.insertAdjacentHTML('beforeend', '<div class="nx-note">Could not load earlier messages.</div>'); }
    },
    /** Sends through ChatUI, so the Team hub shows it at once and "/ai …" asks the assistant just like in the hub. */
    async send(projectId, text) {
      if (!WS.channelId || WS.projectId !== projectId) { notify('The team chat is still connecting. Try again in a moment.'); return false; }
      const r = await S.app.sendMessage(new S.C.GroupChannelIdentifier(WS.channelId), new S.C.SendTextMessageParams({ text }));
      if (!r?.isOk) { notify(`Message not sent (${r?.code ?? 'offline'}). Check your connection.`); return false; }
      wsAppend(r.data); return true;
    },
  };

  // Start in the background once signed in, so unread counts and message toasts work before the hub is opened.
  ensureView();
  const boot = setInterval(() => { if (HC.state?.user) { clearInterval(boot); if (S.status === 'idle') start(); } }, 700);
  HC.openHub = (projectId) => { show(); const p = S.hub.projects.find((x) => x.id === projectId); const general = p?.channels.find((c) => c.key === 'general'); if (general && S.status === 'ready') openGroup(general.id); };
})();
