/* Voice & video calls: several voice channels per project (Discord-style), grid / speaker layouts, mic, camera, screen share, leave.
   Signalling uses a dedicated WebSocket per project (role=call), so a call keeps running while you browse other projects. */
(() => {
  const HC = window.HC; if (!HC) return;
  const { esc, notify, avColor } = HC; const $ = (s, r = document) => r.querySelector(s); const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const CHANNELS = [['general', 'General', '🔊'], ['standup', 'Standup', '☕'], ['focus', 'Focus room', '🎧'], ['pair', 'Pair programming', '👥']];
  const chName = (id) => (CHANNELS.find(c => c[0] === id) || [id, id])[1];
  // Line icons (24px grid, currentColor) used by the call controls instead of emoji.
  const svg = (d, w = 18) => `<svg class="ic" viewBox="0 0 24 24" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const IC = {
    mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
    micOff: svg('<path d="M3 3l18 18"/><path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 9.3V6a3 3 0 0 0-5.7-1.3"/><path d="M5 11a7 7 0 0 0 11.2 5.6M19 11a7 7 0 0 1-.6 2.8M12 18v3"/>'),
    cam: svg('<rect x="2.5" y="6" width="13" height="12" rx="3"/><path d="M15.5 10.5l6-3.5v10l-6-3.5"/>'),
    camOff: svg('<path d="M3 3l18 18"/><path d="M7 6h5.5a3 3 0 0 1 3 3v2.5M15.5 15.5V16a3 3 0 0 1-3 3H5.5a3 3 0 0 1-3-3V9a3 3 0 0 1 1.2-2.4"/><path d="M15.5 10.5l6-3.5v10l-3-1.7"/>'),
    screen: svg('<rect x="3" y="4" width="18" height="12" rx="2.5"/><path d="M8 20h8M12 16v4"/>'),
    leave: svg('<path d="M3.5 14.5c5-5 12-5 17 0l-2.3 2.3a1.5 1.5 0 0 1-1.9.2l-1.8-1.2a1.5 1.5 0 0 1-.6-1.6l.1-.6a8 8 0 0 0-5 0l.1.6a1.5 1.5 0 0 1-.6 1.6l-1.8 1.2a1.5 1.5 0 0 1-1.9-.2z"/>'),
    popout: svg('<path d="M14 4h6v6M20 4l-8 8"/><path d="M18 14v3a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3h3"/>', 16),
    expand: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', 16),
    shrink: svg('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>', 16),
    dock: svg('<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M15 4v16"/>', 16),
    grid: svg('<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>', 16),
    speaker: svg('<rect x="3.5" y="3.5" width="17" height="11" rx="2"/><path d="M5 19.5h3M10.5 19.5h3M16 19.5h3"/>', 16),
    pin: svg('<path d="M12 17v5M8 3h8l-1 6 3 4H6l3-4z"/>', 14),
    share: svg('<rect x="3" y="4" width="18" height="12" rx="2.5"/><path d="M8 20h8M12 16v4"/>', 12)
  };
  const sockets = new Map();           // projectId -> { ws, roster: Map(userId -> {name, initials, channel, mic, cam}) }
  const call = { active: false, projectId: null, projectName: '', channel: null, local: null, screen: null, peers: new Map(), mic: true, cam: true, sharing: false, layout: 'grid', pinned: null, expanded: false, popout: false, selfSpoke: 0, started: 0, tick: null };
  const me = () => HC.state.user;
  const send = (projectId, msg) => { const s = sockets.get(projectId); if (s?.ws?.readyState === 1) s.ws.send(JSON.stringify(msg)); };
  const projectName = (id) => (HC.state.projects || []).find(p => p.id === id)?.name || 'project';

  // ---------- sockets (one per project we watch or call in) ----------
  function watch(projectId) {
    if (!projectId || sockets.has(projectId)) return;
    const entry = { ws: null, roster: new Map() }; sockets.set(projectId, entry);
    window.hcSocketUrl(`/ws?projectId=${encodeURIComponent(projectId)}&role=call`).then((url) => { if (sockets.get(projectId) !== entry) return; entry.ws = new WebSocket(url); wire(projectId, entry); }).catch(() => { if (sockets.get(projectId) === entry) sockets.delete(projectId); });
  }
  function wire(projectId, entry) {
    const ws = entry.ws;
    ws.addEventListener('open', () => { send(projectId, { type: 'call.who' }); for (const f of entry.onOpen?.splice(0) || []) f(); });
    ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } if (m.to && m.to !== me()?.id) return; handle(projectId, entry, m); });
    ws.addEventListener('close', () => { sockets.delete(projectId); if (call.active && call.projectId === projectId) leave(true); renderChannels(); });
  }
  function handle(projectId, entry, m) {
    const inThis = call.active && call.projectId === projectId; const who = { name: m.user, initials: m.initials };
    if (m.type === 'call.who') { if (inThis) send(projectId, { type: 'call.presence', to: m.from, channel: call.channel, mic: call.mic, cam: call.cam }); return; }
    if (m.type === 'call.presence' || m.type === 'call.here' || m.type === 'call.join') {
      entry.roster.set(m.from, { ...who, channel: m.channel, mic: m.mic !== false, cam: m.cam === true });
      if (inThis && m.channel === call.channel) {
        { const pr = peerRec(m.from, m.user); pr.mic = m.mic !== false; pr.cam = m.cam === true; }
        if (m.type === 'call.join') send(projectId, { type: 'call.here', to: m.from, channel: call.channel, mic: call.mic, cam: call.cam });
        if (m.type === 'call.here') connectPeer(m.from, m.user, true);
        if (m.type === 'call.join') { ensureTile(m.from, m.user); notify(`${m.user} joined ${chName(call.channel)}`); }
      }
      renderChannels(); return;
    }
    if (m.type === 'call.state') { const r = entry.roster.get(m.from); if (r) { r.mic = m.mic; r.cam = m.cam; } const p = call.peers.get(m.from); if (p) { const was = p.sharing; p.mic = m.mic; p.cam = m.cam; p.sharing = Boolean(m.sharing); if (inThis && p.sharing && !was) { call.pinned = m.from; call.layout = 'speaker'; notify(`${p.name} is sharing their screen`); } if (inThis && !p.sharing && was && call.pinned === m.from) call.pinned = null; } drawStage(); renderChannels(); return; }
    if (m.type === 'call.move') { if (call.active && call.projectId === projectId) { notify(`${m.user} moved you to ${chName(m.channel)}`); join(projectId, m.channel); } return; }
    if (m.type === 'call.leave') { entry.roster.delete(m.from); if (inThis) { dropPeer(m.from); drawStage(); } renderChannels(); return; }
    if (m.type === 'rtc' && inThis) onSignal(m);
  }

  // ---------- peers ----------
  const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  function peerRec(id, name) { let p = call.peers.get(id); if (!p) { p = { id, name: name || 'Teammate', pc: null, stream: new MediaStream(), mic: true, cam: false, level: 0 }; call.peers.set(id, p); } return p; }
  const ensureTile = (id, name) => { peerRec(id, name); drawStage(); };
  function newPc(p, initiator = true) {
    const pc = new RTCPeerConnection(ICE); p.pc = pc;
    if (initiator) { const a = pc.addTransceiver('audio', { direction: 'sendrecv' }); const v = pc.addTransceiver('video', { direction: 'sendrecv' }); bindSenders(p, a, v); }
    pc.onicecandidate = (e) => { if (e.candidate) send(call.projectId, { type: 'rtc', to: p.id, signal: { type: 'candidate', candidate: e.candidate } }); };
    pc.ontrack = (e) => { p.stream.addTrack(e.track); watchLevel(p.stream, (l) => { p.level = l; pulse(p.id, l); if (l > 14) { p.lastSpoke = Date.now(); scheduleDock(); } }); drawStage(); };
    pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) drawStage(); };
    return pc;
  }
  function bindSenders(p, a, v) { p.aSender = a.sender; p.vSender = v.sender; a.sender.replaceTrack(call.local?.getAudioTracks()[0] || null); v.sender.replaceTrack(videoTrack()); }
  const videoTrack = () => (call.sharing ? call.screen?.getVideoTracks()[0] : call.local?.getVideoTracks()[0]) || null;
  async function connectPeer(id, name, initiator) { const p = peerRec(id, name); if (p.pc) return p; const pc = newPc(p, true); if (initiator) { const offer = await pc.createOffer(); await pc.setLocalDescription(offer); send(call.projectId, { type: 'rtc', to: id, signal: { type: 'offer', sdp: offer } }); } drawStage(); return p; }
  async function onSignal(m) {
    const p = peerRec(m.from, m.user); const s = m.signal; if (!p.pc) newPc(p, false);
    try { if (s.type === 'offer') { await p.pc.setRemoteDescription(s.sdp); { const ts = p.pc.getTransceivers(); const a = ts.find(t => t.receiver.track.kind === 'audio'); const v = ts.find(t => t.receiver.track.kind === 'video'); [a, v].forEach(t => { if (t) t.direction = 'sendrecv'; }); if (a && v) bindSenders(p, a, v); } const ans = await p.pc.createAnswer(); await p.pc.setLocalDescription(ans); send(call.projectId, { type: 'rtc', to: m.from, signal: { type: 'answer', sdp: ans } }); } else if (s.type === 'answer') await p.pc.setRemoteDescription(s.sdp); else if (s.type === 'candidate') await p.pc.addIceCandidate(s.candidate); } catch { /* stale signal */ }
  }
  function dropPeer(id) { const p = call.peers.get(id); if (!p) return; try { p.pc?.close(); } catch { /* closed */ } call.peers.delete(id); if (call.pinned === id) call.pinned = null; }

  // ---------- speaking detection ----------
  let ac; const watchers = new WeakMap();
  function watchLevel(stream, cb) { if (watchers.has(stream) || !stream.getAudioTracks().length) return; try { ac ||= new (window.AudioContext || window.webkitAudioContext)(); const an = ac.createAnalyser(); an.fftSize = 256; ac.createMediaStreamSource(stream).connect(an); const buf = new Uint8Array(an.frequencyBinCount); watchers.set(stream, true); const loop = () => { if (!call.active) return; an.getByteFrequencyData(buf); cb(buf.reduce((n, v) => n + v, 0) / buf.length); requestAnimationFrame(loop); }; loop(); } catch { /* no audio api */ } }
  const pulse = (id, level) => { const t = $(`.ct[data-id="${CSS.escape(id)}"]`); if (t) t.classList.toggle('speaking', level > 14); };

  // ---------- join / leave / controls ----------
  async function join(projectId, channel) {
    if (call.active) leave(true);
    try { call.local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); call.cam = false; } catch (e) { notify(`Microphone permission denied: ${e.message}`); return; }
    Object.assign(call, { active: true, projectId, projectName: projectName(projectId), channel, mic: true, sharing: false, popout: false, expanded: false, peers: new Map(), pinned: null, started: Date.now() }); watch(projectId);
    const go = () => { send(projectId, { type: 'call.join', channel, mic: true, cam: call.cam }); sockets.get(projectId).roster.set(me().id, { name: me().name, initials: me().initials, channel, mic: true, cam: call.cam }); };
    { const s = sockets.get(projectId); if (s?.ws?.readyState === 1) go(); else (s.onOpen ||= []).push(go); }
    watchLevel(call.local, (l) => { pulse('self', l); if (l > 14 && call.mic) { call.selfSpoke = Date.now(); scheduleDock(); } }); call.tick = setInterval(() => { const t = $('#callTimer'); if (t) { const s = Math.floor((Date.now() - call.started) / 1000); t.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; } }, 1000);
    drawStage(); renderChannels(); syncCallBtn(); notify(`Joined ${chName(channel)} with voice. Use the camera button when you want to show your video.`);
  }
  function leave(silent = false) {
    if (!call.active) return; send(call.projectId, { type: 'call.leave' }); sockets.get(call.projectId)?.roster.delete(me().id);
    for (const id of [...call.peers.keys()]) dropPeer(id); call.local?.getTracks().forEach(t => t.stop()); call.screen?.getTracks().forEach(t => t.stop()); clearInterval(call.tick);
    Object.assign(call, { active: false, local: null, screen: null, sharing: false, expanded: false, channel: null, peers: new Map() }); $('#callStage')?.remove(); $('#callDock')?.remove(); document.body.classList.remove('call-full'); renderChannels(); syncCallBtn(); if (!silent) notify('You left the call');
  }
  const broadcastState = () => send(call.projectId, { type: 'call.state', mic: call.mic, cam: call.cam, sharing: call.sharing });
  function toggleMic() { call.mic = !call.mic; call.local?.getAudioTracks().forEach(t => { t.enabled = call.mic; }); broadcastState(); drawStage(); }
  async function toggleCam() {
    if (call.cam) { call.local?.getVideoTracks().forEach(t => { t.stop(); call.local.removeTrack(t); }); call.cam = false; }
    else { try { const s = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 360 } }); call.local.addTrack(s.getVideoTracks()[0]); call.cam = true; } catch (e) { notify(`Camera unavailable: ${e.message}`); return; } }
    if (!call.sharing) call.peers.forEach(p => p.vSender?.replaceTrack(videoTrack())); broadcastState(); drawStage();
  }
  async function toggleShare() {
    const restore = () => { call.sharing = false; call.screen?.getTracks().forEach(t => t.stop()); call.screen = null; call.peers.forEach(p => p.vSender?.replaceTrack(videoTrack())); broadcastState(); drawStage(); };
    if (call.sharing) { restore(); return; }
    if (!navigator.mediaDevices?.getDisplayMedia) { notify('Your browser does not support screen sharing'); return; }
    try {
      call.screen = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'always' }, audio: false }); call.sharing = true; const track = call.screen.getVideoTracks()[0]; track.onended = restore;
      call.peers.forEach(p => p.vSender?.replaceTrack(track)); call.pinned = 'self'; call.layout = 'speaker'; broadcastState(); drawStage(); notify('You are sharing your screen. Everyone in the call sees it.');
    } catch (e) { call.sharing = false; if (e.name !== 'NotAllowedError') notify(`Screen sharing failed: ${e.message}`); }
  }

  // ---------- stage (floating window or full screen) ----------
  const tiles = () => [{ id: 'self', name: `${me().name} (you)`, stream: call.sharing && call.screen ? call.screen : call.local, mic: call.mic, cam: call.cam || call.sharing, share: call.sharing, self: true, last: call.selfSpoke || 0 }, ...[...call.peers.values()].map(p => ({ id: p.id, name: p.name, stream: p.stream, mic: p.mic, share: Boolean(p.sharing), last: p.lastSpoke || 0, cam: (p.cam === true || p.sharing) && p.stream.getVideoTracks().length > 0 }))];
  const initials = (n) => String(n).replace(/\(you\)/, '').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  // Where the call is shown: 'dock' (compact tiles in the right panel, the default), 'popout' (floating window, on request) or 'full'.
  // With no side panel to dock into (other pages, narrow screens) the call falls back to the floating window so it can always be controlled.
  const hasPanel = () => { const a = $('.collab-panel'); return Boolean(a && a.offsetWidth > 0); };
  const callMode = () => call.expanded ? 'full' : (call.popout || !hasPanel()) ? 'popout' : 'dock';
  let dockSig = '', dockTimer = null;
  const scheduleDock = () => { if (dockTimer || !call.active || callMode() !== 'dock') return; dockTimer = setTimeout(() => { dockTimer = null; if (call.active && callMode() === 'dock' && visibleDock(tiles()).map(t => t.id).join() !== dockSig) drawStage(); }, 1200); };
  function visibleDock(list) {
    const rank = (t) => (t.id === call.pinned ? 1e15 : 0) + (t.share ? 1e14 : 0) + t.last + (t.cam ? 1 : 0);
    const others = list.filter(t => !t.self).sort((a, b) => rank(b) - rank(a)); const me0 = list.find(t => t.self); let vis = others.slice(0, 4);
    if (me0) { if (vis.length < 4) vis.push(me0); else if (me0.cam || me0.share || me0.id === call.pinned) vis[3] = me0; }
    return vis;
  }
  const act = { mic: () => toggleMic(), cam: () => toggleCam(), share: () => toggleShare(), leave: () => leave(),
    layout: () => { call.layout = call.layout === 'grid' ? 'speaker' : 'grid'; drawStage(); },
    expand: () => { call.expanded = !call.expanded; document.body.classList.toggle('call-full', call.expanded); drawStage(); },
    popout: () => { call.popout = true; call.expanded = false; document.body.classList.remove('call-full'); const st = $('#callStage'); if (st) st.dataset.sized = ''; drawStage(); },
    dock: () => { call.popout = false; call.expanded = false; document.body.classList.remove('call-full'); drawStage(); } };
  function drawDock() {
    let d = $('#callDock'); const aside = $('.collab-panel'); if (!aside) return;
    if (!d) { d = document.createElement('div'); d.id = 'callDock'; const tabs = $('.side-tabs', aside); tabs ? tabs.after(d) : aside.prepend(d); }
    const list = tiles(); const vis = visibleDock(list); dockSig = vis.map(t => t.id).join(); const more = list.length - vis.length;
    const main = vis.length > 1 ? (vis.find(t => t.id === call.pinned) || vis.find(t => t.share && !t.self)) : null; const rest = main ? vis.filter(t => t !== main) : vis;
    const tile = (t) => `<div class="ct ${t.cam ? '' : 'nocam'} ${t.share ? 'share' : ''} ${t.id === call.pinned ? 'pinned' : ''}" data-id="${esc(t.id)}" style="--c:${avColor(t.name)}" title="${t.id === call.pinned ? 'Click to shrink' : 'Click to enlarge'}"><video ${t.self ? 'muted' : ''} autoplay playsinline></video><div class="ct-av">${esc(initials(t.name))}</div><div class="ct-name">${t.mic ? '' : `<i class="mic-off">${IC.micOff.replace('width="18" height="18"', 'width="12" height="12"')}</i>`}${t.share ? `<i class="ct-sh">${IC.share}</i>` : ''}${esc(t.share && t.self ? 'Your screen' : t.name)}</div></div>`;
    const prev = new Map($$('.ct video', d).map(v => [v.closest('.ct').dataset.id, v]));
    d.innerHTML = `<div class="cd"><div class="cd-head"><div class="cd-title"><b># ${esc(chName(call.channel))}</b><span>${list.length} in call · <span id="callTimer">00:00</span></span></div><div class="cd-hr"><button data-a="popout" title="Pop out into a floating window" aria-label="Pop out">${IC.popout}</button><button data-a="expand" title="Full screen" aria-label="Full screen">${IC.expand}</button></div></div>
      <div class="cd-body">${main ? `<div class="cd-main">${tile(main)}</div>` : ''}<div class="cd-grid" data-n="${rest.length}">${rest.map(tile).join('')}</div>${more > 0 ? `<div class="cd-more">+${more} more in the call</div>` : ''}</div>
      <div class="cd-bar"><button class="cb ${call.mic ? '' : 'off'}" data-a="mic" title="${call.mic ? 'Mute' : 'Unmute'}" aria-label="${call.mic ? 'Mute' : 'Unmute'}">${call.mic ? IC.mic : IC.micOff}</button><button class="cb ${call.cam ? '' : 'off'}" data-a="cam" title="${call.cam ? 'Turn your video off' : 'Turn your video on'}" aria-label="Toggle video">${call.cam ? IC.cam : IC.camOff}</button><button class="cb ${call.sharing ? 'on' : ''}" data-a="share" title="${call.sharing ? 'Stop sharing' : 'Share your screen'}" aria-label="Share screen">${IC.screen}</button><button class="cb hang" data-a="leave" title="Leave call">${IC.leave}<span>Leave</span></button></div></div>`;
    $$('.ct', d).forEach(el => { const t = list.find(x => x.id === el.dataset.id); let v = $('video', el); const st0 = t?.stream; const old = prev.get(el.dataset.id); if (v && st0) { if (old && old.srcObject === st0) { v.replaceWith(old); v = old; } else v.srcObject = st0; v.play?.().catch(() => {}); } el.addEventListener('click', () => { call.pinned = call.pinned === el.dataset.id ? null : el.dataset.id; drawStage(); }); });
    $$('[data-a]', d).forEach(b => b.addEventListener('click', () => act[b.dataset.a]()));
  }
  function drawStage() {
    if (!call.active) return;
    if (callMode() === 'dock') { $('#callStage')?.remove(); drawDock(); return; }
    $('#callDock')?.remove(); let st = $('#callStage');
    if (!st) { st = document.createElement('div'); st.id = 'callStage'; document.body.appendChild(st); st.addEventListener('pointerdown', (e) => startResize(st, e)); }
    st.className = `${call.expanded ? 'full' : 'mini'} layout-${call.layout}`; const list = tiles(); const main = call.layout === 'speaker' ? (list.find(t => t.id === call.pinned) || list.find(t => !t.self) || list[0]) : null; const rest = main ? list.filter(t => t !== main) : list;
    const tile = (t, big) => `<div class="ct ${t.cam ? '' : 'nocam'} ${t.share ? 'share' : ''} ${t.id === call.pinned ? 'pinned' : ''}" data-id="${esc(t.id)}" style="--c:${avColor(t.name)}"><video ${t.self ? 'muted' : ''} autoplay playsinline></video><div class="ct-av">${esc(initials(t.name))}</div><div class="ct-name">${t.mic ? '' : `<i class="mic-off">${IC.micOff.replace('width="18" height="18"', 'width="12" height="12"')}</i>`}${t.share ? `<i class="ct-sh">${IC.share}</i>` : ''}${esc(t.share && t.self ? 'Your screen' : t.name)}</div><button class="ct-pin" data-pin="${esc(t.id)}" title="Pin / spotlight">${IC.pin}</button></div>`;
    const prev = new Map($$('.ct video', st).map(v => [v.closest('.ct').dataset.id, v]));
    st.innerHTML = `<div class="call-head"><div class="call-title"><b># ${esc(chName(call.channel))}</b><span class="call-sub" title="${esc(call.projectName)}">${call.expanded ? esc(call.projectName) + ' · ' : ''}${list.length} in call · <span id="callTimer">00:00</span></span></div><div class="call-head-r"><button data-a="dock" title="Back to the side panel" aria-label="Dock">${IC.dock}<span class="lbl">Dock</span></button><button data-a="layout" title="Switch grid / speaker view" aria-label="Switch layout">${call.layout === 'grid' ? IC.grid : IC.speaker}<span class="lbl">${call.layout === 'grid' ? 'Grid' : 'Speaker'}</span></button><button data-a="expand" title="${call.expanded ? 'Back to workspace' : 'Full screen'}" aria-label="${call.expanded ? 'Back' : 'Expand'}">${call.expanded ? IC.shrink : IC.expand}<span class="lbl">${call.expanded ? 'Back' : 'Expand'}</span></button></div></div>
      <div class="call-body ${main ? 'with-main' : ''}" data-n="${list.length}">${main ? `<div class="call-main">${tile(main, true)}</div><div class="call-strip">${rest.map(t => tile(t)).join('')}</div>` : `<div class="call-grid" data-n="${Math.min(list.length, 9)}">${list.map(t => tile(t)).join('')}</div>`}</div>
      ${call.expanded ? '' : '<i class="rz nw" data-rz="nw"></i><i class="rz ne" data-rz="ne"></i><i class="rz sw" data-rz="sw"></i><i class="rz se" data-rz="se"></i>'}<div class="call-bar2"><button class="cb ${call.mic ? '' : 'off'}" data-a="mic" title="Microphone">${call.mic ? IC.mic : IC.micOff}<span>${call.mic ? 'Mute' : 'Unmute'}</span></button><button class="cb ${call.cam ? '' : 'off'}" data-a="cam" title="${call.cam ? 'Turn your video off' : 'Turn your video on (others will see you)'}">${call.cam ? IC.cam : IC.camOff}<span>${call.cam ? 'Stop video' : 'Start video'}</span></button><button class="cb ${call.sharing ? 'on' : ''}" data-a="share" title="Share your screen">${IC.screen}<span>${call.sharing ? 'Stop sharing' : 'Share'}</span></button><button class="cb hang" data-a="leave" title="Leave call">${IC.leave}<span>Leave</span></button></div>`;
    $$('.ct', st).forEach(el => { const t = list.find(x => x.id === el.dataset.id); let v = $('video', el); const s = t?.stream; const old = prev.get(el.dataset.id); if (v && s) { if (old && old.srcObject === s) { v.replaceWith(old); v = old; } else v.srcObject = s; v.play?.().catch(() => {}); } });
    $$('[data-a]', st).forEach(b => b.addEventListener('click', () => act[b.dataset.a]()));
    $$('[data-pin]', st).forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); call.pinned = call.pinned === b.dataset.pin ? null : b.dataset.pin; if (call.pinned) call.layout = 'speaker'; drawStage(); }));
    dragify(st); if (!call.expanded) { if (!st.dataset.sized) { applyRect(st); st.dataset.sized = 1; } } else { st.dataset.sized = ''; Object.assign(st.style, { width: '', height: '', left: '', top: '', right: '', bottom: '' }); }
    $$('.ct', st).forEach(el => el.addEventListener('dblclick', () => { call.pinned = el.dataset.id; call.layout = 'speaker'; drawStage(); }));
  }



  // The small window is resized by dragging any of its four corners (like a normal desktop window).
  let rect = null; try { rect = JSON.parse(localStorage.getItem('hc-call-rect') || 'null'); } catch { /* ignore */ }
  const MIN_W = 260, MIN_H = 200; const saveRect = (r) => { rect = r; localStorage.setItem('hc-call-rect', JSON.stringify(r)); };
  function applyRect(st) { const r = rect || { w: 360, h: 300 }; st.style.width = r.w + 'px'; st.style.height = r.h + 'px'; if (rect && rect.x != null) Object.assign(st.style, { left: rect.x + 'px', top: rect.y + 'px', right: 'auto', bottom: 'auto' }); }
  function startResize(st, e) {
    const h = e.target.closest('[data-rz]'); if (!h) return; e.preventDefault(); const dir = h.dataset.rz; const r0 = st.getBoundingClientRect(); const sx = e.clientX, sy = e.clientY; h.setPointerCapture(e.pointerId); st.classList.add('resizing');
    const move = (m) => { let { left: x, top: y, width: w, height: ht } = r0; const dx = m.clientX - sx, dy = m.clientY - sy;
      if (dir.includes('e')) w = Math.min(innerWidth - x, Math.max(MIN_W, r0.width + dx)); if (dir.includes('s')) ht = Math.min(innerHeight - y, Math.max(MIN_H, r0.height + dy));
      if (dir.includes('w')) { w = Math.min(r0.right, Math.max(MIN_W, r0.width - dx)); x = r0.right - w; } if (dir.includes('n')) { ht = Math.min(r0.bottom, Math.max(MIN_H, r0.height - dy)); y = r0.bottom - ht; }
      Object.assign(st.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: ht + 'px', right: 'auto', bottom: 'auto' }); saveRect({ x, y, w, h: ht }); };
    const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); st.classList.remove('resizing'); }; h.addEventListener('pointermove', move); h.addEventListener('pointerup', up);
  }

  // The small call window can be dragged anywhere so it never covers what you are working on.
    function dragify(st) {
    const head = $('.call-head', st); if (!head || call.expanded) return; head.style.cursor = 'grab';
    head.onpointerdown = (e) => { if (e.target.closest('button')) return; const r = st.getBoundingClientRect(); const dx = e.clientX - r.left, dy = e.clientY - r.top; head.setPointerCapture(e.pointerId); head.style.cursor = 'grabbing';
      head.onpointermove = (m) => { const x = Math.min(innerWidth - 80, Math.max(0, m.clientX - dx)), y = Math.min(innerHeight - 60, Math.max(0, m.clientY - dy)); Object.assign(st.style, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto' }); const rr = st.getBoundingClientRect(); saveRect({ x, y, w: Math.round(rr.width), h: Math.round(rr.height) }); };
      head.onpointerup = () => { head.onpointermove = null; head.style.cursor = 'grab'; }; };
  }

  // ---------- voice channel list (People tab) ----------
  function renderChannels() {
    const box = $('#voiceChannels'); const pid = HC.state.currentProject?.id; if (!box) return; if (!pid) { box.innerHTML = ''; return; }
    const roster = sockets.get(pid)?.roster || new Map();
    box.innerHTML = `<div class="vc-head">Voice channels</div>${CHANNELS.map(([id, name, icon]) => { const here = [...roster.entries()].filter(([, r]) => r.channel === id && (call.active && call.projectId === pid ? true : true)); const mine = call.active && call.projectId === pid && call.channel === id;
      return `<div class="vc ${mine ? 'mine' : ''}"><button class="vc-row" data-ch="${id}" title="${mine ? 'You are here' : 'Join ' + esc(name)}"><span class="vc-ic">${icon}</span><span class="vc-name">${esc(name)}</span>${here.length ? `<span class="vc-count">${here.length}</span>` : ''}</button>${here.length ? `<div class="vc-people">${here.map(([uid, r]) => `<span class="vc-p ${r.mic ? '' : 'muted'}" draggable="true" data-uid="${esc(uid)}" title="Drag to another channel"><i style="background:${avColor(r.name)}">${esc(initials(r.name))}</i>${esc(r.name)}${r.mic ? '' : ' 🔇'}</span>`).join('')}</div>` : ''}</div>`; }).join('')}
      ${call.active ? `<div class="vc-live"><span class="live-dot"></span> Connected to <b>${esc(chName(call.channel))}</b> in ${esc(call.projectName)}<button class="outline-button btn-sm" data-a2="leave">Leave</button></div>` : '<div class="muted small" style="padding:8px 2px">Pick a channel to talk. Other projects have their own channels, and you can stay in a call while you browse.</div>'}`;
    $$('[data-ch]', box).forEach(b => b.addEventListener('click', () => { if (call.active && call.projectId === pid && call.channel === b.dataset.ch) { call.expanded = true; document.body.classList.add('call-full'); drawStage(); } else join(pid, b.dataset.ch); }));
    $$('[data-a2]', box).forEach(b => b.addEventListener('click', () => leave()));
    $$('.vc-p', box).forEach(el => { el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', el.dataset.uid); e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging'); box.classList.add('dnd'); }); el.addEventListener('dragend', () => { el.classList.remove('dragging'); box.classList.remove('dnd'); $$('.vc.over', box).forEach(x => x.classList.remove('over')); }); });
    $$('.vc', box).forEach(vc => { const ch = $('[data-ch]', vc).dataset.ch; vc.addEventListener('dragover', (e) => { e.preventDefault(); vc.classList.add('over'); }); vc.addEventListener('dragleave', () => vc.classList.remove('over'));
      vc.addEventListener('drop', (e) => { e.preventDefault(); vc.classList.remove('over'); const uid = e.dataTransfer.getData('text/plain'); if (!uid) return; const cur = roster.get(uid); if (cur?.channel === ch) return;
        if (uid === me().id) { join(pid, ch); return; } if (!(call.active && call.projectId === pid)) { notify('Join the call first, then you can move people between channels'); return; }
        send(pid, { type: 'call.move', to: uid, channel: ch }); if (cur) { cur.channel = ch; renderChannels(); } notify(`Moved ${cur?.name || 'them'} to ${chName(ch)}`); }); });
  }
  function syncCallBtn() { const b = $('#callBtn'); if (!b) return; b.textContent = call.active ? '● In call' : '● Call'; b.classList.toggle('in-call', call.active); }
  document.addEventListener('click', (e) => { const b = e.target.closest?.('#callBtn'); if (!b) return; e.stopImmediatePropagation(); const pid = HC.state.currentProject?.id; if (!pid) { notify('Open a project first to start a call'); return; } if (call.active) { call.expanded = !call.expanded; document.body.classList.toggle('call-full', call.expanded); drawStage(); } else join(pid, 'general'); }, true);

  // keep the roster socket in step with the open project; refresh the channel list when the panel appears
  let lastPid = null; setInterval(() => { const pid = HC.state.currentProject?.id; if (pid && pid !== lastPid) { lastPid = pid; watch(pid); for (const [id, s] of sockets) if (id !== pid && !(call.active && call.projectId === id)) { s.ws.close(); sockets.delete(id); } } if (call.active) { const m = callMode(); if (m === 'dock' ? !$('#callDock .cd') : !$('#callStage')) drawStage(); } if (me()) { const box = $('#voiceChannels'); if (box && box.dataset.pid !== String(pid || '')) { box.dataset.pid = String(pid || ''); renderChannels(); } syncCallBtn(); } }, 700);
  new MutationObserver(() => { const box = $('#voiceChannels'); const pid = HC.state.currentProject?.id || ''; if (box && box.dataset.pid !== pid) { box.dataset.pid = pid; renderChannels(); } }).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('beforeunload', () => { if (call.active) send(call.projectId, { type: 'call.leave' }); });
  HC.call = { join, leave, state: call };
})();
