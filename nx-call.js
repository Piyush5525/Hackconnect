/* Voice and video calls on the Nexconn Call SDK (@nexconn/call, window.HCNex.call).
   - 1:1 calls from a direct conversation, group calls from a project channel or the Live workspace's Call button.
   - Incoming calls ring with Accept / Decline; the call window shows everyone's video (or their initials when the
     camera is off), with mic, camera, device choice, "invite more" for group calls, and hang up.
   The call engine rides on the same Nexconn connection as the Team hub (hub-ui.js installs it before connecting),
   so it starts once the hub reports "ready". Builds on window.HC (app.js) and HC.hub / HC.nxProfile (hub-ui.js). */
(() => {
  const HC = window.HC; if (!HC) return;
  const { esc, notify, avColor, modal } = HC;
  const $ = (s, r = document) => r.querySelector(s); const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const icon = (d, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const I = {
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/>', micOff: '<path d="M3 3l18 18"/><path d="M9 9v2a3 3 0 005 2.2M15 9.3V6a3 3 0 00-5.8-1"/><path d="M5 11a7 7 0 0011.5 5.3M19 11a7 7 0 01-.6 2.8M12 18v3"/>',
    cam: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/>', camOff: '<path d="M3 3l18 18"/><path d="M16 16v1a1 1 0 01-1 1H5a2 2 0 01-2-2V8a2 2 0 012-2h1M10 6h5a1 1 0 011 1v3l5-3v10"/>',
    end: '<path d="M3 15c5-4.5 13-4.5 18 0l-2.5 2.5-3.5-1.5v-3a10 10 0 00-6 0v3l-3.5 1.5z"/>', phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z"/>',
    add: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0114 0M19 8v6M16 11h6"/>', gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
    expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', shrink: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  };
  const ERR = { 80006: 'Calling is not switched on for this Nexconn app yet. An admin activates it under Call → Call Subscription in the Nexconn console.', 80002: 'You are already in a call.', 80007: 'Nobody to call: pick at least one teammate.', 80001: 'The call could not be started (invalid request).' };
  const why = (code) => ERR[code] || `The call could not be started (code ${code}). Check your connection and try again.`;

  const C = { eng: null, K: null, callId: null, phase: 'idle', video: false, mic: true, cam: false, peers: new Map(), title: '', projectId: null, startedAt: 0, incoming: null, big: false, tick: null };
  const me = () => HC.hub?.hub?.me; const nameOf = (id) => (HC.nxProfile ? HC.nxProfile(id).name : 'Teammate');
  const initials = (n) => String(n || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const avatarOf = (id) => { const p = HC.hub?.hub?.people?.[id]; return p?.avatar || ''; };

  /** Create the call engine on first use. Needs the Team hub's Nexconn connection. */
  function engine() {
    if (C.eng) return C.eng; if (HC.hub?.status !== 'ready' || !window.HCNex?.call) return null;
    const K = C.K = window.HCNex.call; const eng = C.eng = K.NCCallEngine.initialize({});
    eng.setCallEventHandler({
      onCallReceived: (e) => incoming(e.session, e.extra),
      onCallConnected: (e) => { C.callId = e.session.getCallId(); C.phase = 'live'; C.startedAt ||= Date.now(); stopRing(); for (const u of e.session.getRemoteParticipants() || []) peer(u.userId, { state: u.userState, cam: u.isCameraEnabled, mic: u.isMicrophoneEnabled }); draw(); },
      onCallEnded: (e) => ended(e.reason),
      onRemoteUserStateChanged: (e) => {
        const S = C.K.NCCallUserState; const name = nameOf(e.userId);
        if ([S.ENDED, S.DECLINED, S.NO_ANSWER, S.CANCELED, S.MISSED, S.ERROR].includes(e.userState)) { C.peers.delete(e.userId); if (e.userState === S.DECLINED) notify(`${name} declined the call`); else if (e.userState === S.NO_ANSWER) notify(`${name} did not answer`); else if (C.phase === 'live') notify(`${name} left the call`); }
        else peer(e.userId, { state: e.userState });
        draw();
      },
      onRemoteCameraStateChanged: (e) => { peer(e.userId, { cam: !e.disabled }); draw(); },
      onRemoteMicrophoneStateChanged: (e) => { peer(e.userId, { mic: !e.disabled }); draw(); },
      onRemoteUserInvited: (e) => { for (const id of e.calleeIds || e.userIds || [e.userId].filter(Boolean)) peer(id, { state: C.K.NCCallUserState.INVITED }); draw(); },
      onStartTimeReceived: (e) => { if (e.startTime) C.startedAt = e.startTime; },
    });
    return eng;
  }
  const peer = (id, patch) => { if (!id || id === me()) return; const p = C.peers.get(id) || { id, state: 0, cam: C.video, mic: true }; Object.assign(p, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))); C.peers.set(id, p); };

  // ---------- ringing (a soft two-tone, made in the browser; no audio file needed) ----------
  let ring = null;
  function startRing(kind) {
    stopRing(); let ac; try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; }
    const beep = () => { const t = ac.currentTime; for (const [f, at] of kind === 'in' ? [[880, 0], [660, 0.22]] : [[440, 0]]) { const o = ac.createOscillator(); const g = ac.createGain(); o.frequency.value = f; g.gain.setValueAtTime(0.0001, t + at); g.gain.exponentialRampToValueAtTime(0.12, t + at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.2); o.connect(g).connect(ac.destination); o.start(t + at); o.stop(t + at + 0.22); } };
    beep(); ring = { ac, timer: setInterval(beep, kind === 'in' ? 1600 : 2600) };
  }
  function stopRing() { if (!ring) return; clearInterval(ring.timer); ring.ac.close?.().catch(() => {}); ring = null; }

  // ---------- start / answer / end ----------
  async function start({ userIds, title, video = false, group = false, projectId = null, targetId }) {
    const eng = engine(); if (!eng) { notify(HC.hub?.status === 'off' ? 'Calls run on Nexconn, which is not switched on for this server.' : 'Still connecting to Nexconn. Try again in a moment.'); return; }
    if (C.phase !== 'idle') { notify('You are already in a call.'); return; }
    const callees = [...new Set(userIds)].filter((id) => id && id !== me()); if (!callees.length) { notify('Nobody else is on this project yet. Invite a teammate first.'); return; }
    const K = C.K; Object.assign(C, { phase: 'calling', video, cam: video, mic: true, title, projectId, startedAt: 0, peers: new Map(), big: false });
    for (const id of callees) peer(id, { state: K.NCCallUserState.CALLING, cam: video });
    draw(); startRing('out');
    const r = await eng.startCall({ calleeIds: callees, callType: group || callees.length > 1 ? K.NCCallType.MULTI : K.NCCallType.SINGLE, mediaType: video ? K.NCCallMediaType.AUDIO_VIDEO : K.NCCallMediaType.AUDIO, extra: JSON.stringify({ title, projectId }), ...(targetId ? { targetId } : {}) }).catch((error) => ({ code: -1, error }));
    if (r.code !== 0 || !r.callId) { stopRing(); reset(); notify(why(r.code)); return; }
    C.callId = r.callId; draw();
  }
  function incoming(session, extra) {
    if (C.phase !== 'idle') return; // the SDK answers "busy" for us
    let info = {}; try { info = JSON.parse(extra || '{}') || {}; } catch { info = {}; }
    const K = C.K; const from = session.getCallerUserId(); const video = session.getMediaType() === K.NCCallMediaType.AUDIO_VIDEO; const group = session.getCallType() === K.NCCallType.MULTI;
    C.incoming = { callId: session.getCallId(), from, video, group, title: info.title || nameOf(from), projectId: info.projectId || null };
    startRing('in'); drawIncoming();
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') { try { new Notification(`${nameOf(from)} is calling`, { body: group ? info.title || 'Group call' : video ? 'Video call' : 'Voice call', tag: 'hc-call' }); } catch { /* not allowed here */ } }
  }
  async function accept() {
    const inc = C.incoming; if (!inc) return; C.incoming = null; $('#nxRing')?.remove(); stopRing();
    Object.assign(C, { phase: 'connecting', callId: inc.callId, video: inc.video, cam: inc.video, mic: true, title: inc.title, projectId: inc.projectId, startedAt: 0, peers: new Map(), big: false });
    peer(inc.from, { state: C.K.NCCallUserState.CONNECTING, cam: inc.video }); draw();
    const r = await C.eng.acceptCall({ callId: inc.callId }).catch(() => ({ code: -1 })); if (r.code !== 0) { reset(); notify(why(r.code)); }
  }
  async function decline() { const inc = C.incoming; C.incoming = null; $('#nxRing')?.remove(); stopRing(); if (inc) await C.eng.endCall({ callId: inc.callId }).catch(() => {}); }
  async function hangup() { const id = C.callId; stopRing(); reset(); if (id) await C.eng?.endCall({ callId: id }).catch(() => {}); }
  function ended(reason) {
    if (C.incoming) { C.incoming = null; $('#nxRing')?.remove(); stopRing(); notify('Missed call'); return; }
    if (C.phase === 'idle') return; const R = C.K.NCCallEndReason; const was = C.phase; stopRing(); reset();
    if (was === 'calling' && reason === R.NO_ANSWER) notify('No answer'); else if (reason === R.DECLINED) notify('Call declined'); else if (was === 'live') notify('Call ended');
  }
  function reset() { clearInterval(C.tick); Object.assign(C, { phase: 'idle', callId: null, peers: new Map(), startedAt: 0, incoming: null }); $('#nxStage')?.remove(); document.body.classList.remove('nx-call-big'); syncButtons(); }

  async function toggleMic() { const next = !C.mic; const r = await C.eng.enableMicrophone(next).catch(() => ({ code: -1 })); if (r.code === 0) C.mic = next; else notify('Could not change the microphone'); draw(); }
  async function toggleCam() { const next = !C.cam; const r = await C.eng.enableCamera(next).catch(() => ({ code: -1 })); if (r.code === 0) C.cam = next; else notify(C.video ? 'Could not change the camera' : 'This is a voice call. Start a video call to share your camera.'); draw(); }
  async function devices() {
    const [mics, cams, outs] = await Promise.all([C.eng.getAudioInputDevices().catch(() => []), C.video ? C.eng.getVideoInputDevices().catch(() => []) : [], C.eng.getAudioOutputDevices().catch(() => [])]);
    const sel = (id, label, list) => list.length ? `<label class="hc-field">${label}<select class="inp" id="${id}">${list.map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || `${label} ${i + 1}`)}</option>`).join('')}</select></label>` : '';
    const m = modal({ title: 'Call devices', width: 440, body: sel('dvMic', 'Microphone', mics) + sel('dvCam', 'Camera', cams) + sel('dvOut', 'Speaker', outs) || '<p class="muted">No devices found.</p>', actions: [{ label: 'Close' }, { label: 'Use these', kind: 'primary', onClick: async () => {
      if (m.$('#dvMic')) await C.eng.selectAudioInputDevice({ deviceId: m.$('#dvMic').value }).catch(() => {}); if (m.$('#dvCam')) await C.eng.selectVideoInputDevice({ deviceId: m.$('#dvCam').value }).catch(() => {}); if (m.$('#dvOut')) await C.eng.selectAudioOutputDevice({ deviceId: m.$('#dvOut').value }).catch(() => {});
    } }] });
  }
  function inviteMore() {
    const proj = HC.hub?.hub?.projects?.find((p) => p.id === C.projectId); const inCall = new Set([...C.peers.keys(), me()]);
    const free = (proj?.members || []).map((m) => m.nx).filter((id) => !inCall.has(id)); if (!free.length) { notify('Everyone on the project is already in the call.'); return; }
    const m = modal({ title: 'Invite to the call', width: 420, body: `<div class="hub-pick">${free.map((id) => `<label class="hub-person"><input type="checkbox" value="${esc(id)}" checked> <span>${esc(nameOf(id))}</span></label>`).join('')}</div>`, actions: [{ label: 'Cancel' }, { label: 'Invite', kind: 'primary', onClick: async () => {
      const ids = m.$$('input:checked').map((b) => b.value); if (!ids.length) return false; const r = await C.eng.inviteToCall({ calleeIds: ids }).catch(() => ({ code: -1 })); if (r.code !== 0) { notify(why(r.code)); return false; } for (const id of ids) peer(id, { state: C.K.NCCallUserState.INVITED }); draw();
    } }] });
  }

  // ---------- UI ----------
  function drawIncoming() {
    $('#nxRing')?.remove(); const inc = C.incoming; if (!inc) return; const el = document.createElement('div'); el.id = 'nxRing'; el.className = 'nx-ring'; el.setAttribute('role', 'alertdialog'); el.setAttribute('aria-label', 'Incoming call');
    el.innerHTML = `<div class="nx-ring-av" style="--c:${avColor(nameOf(inc.from))}">${esc(initials(nameOf(inc.from)))}</div><div class="nx-ring-tx"><b>${esc(nameOf(inc.from))}</b><small>${inc.group ? `Group ${inc.video ? 'video' : 'voice'} call · ${esc(inc.title)}` : `${inc.video ? 'Video' : 'Voice'} call`}</small></div><button class="nx-btn no" data-a="no" title="Decline" aria-label="Decline">${icon(I.end)}</button><button class="nx-btn yes" data-a="yes" title="Accept" aria-label="Accept">${icon(inc.video ? I.cam : I.phone)}</button>`;
    document.body.appendChild(el); $('[data-a=yes]', el).addEventListener('click', accept); $('[data-a=no]', el).addEventListener('click', decline); $('[data-a=yes]', el).focus();
  }
  const stateText = (p) => { const S = C.K.NCCallUserState; return p.state === S.ONCALL ? '' : p.state === S.CONNECTING ? 'Connecting…' : [S.CALLING, S.INVITED, S.RINGING].includes(p.state) ? 'Ringing…' : ''; };
  const clock = () => { if (!C.startedAt) return C.phase === 'calling' ? 'Calling…' : C.phase === 'connecting' ? 'Connecting…' : ''; const s = Math.max(0, Math.floor((Date.now() - C.startedAt) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  function tile(id, mine) {
    const name = mine ? 'You' : nameOf(id); const p = mine ? { cam: C.cam, mic: C.mic, state: C.K.NCCallUserState.ONCALL } : C.peers.get(id); const pic = avatarOf(id);
    return `<div class="nx-tile ${p.cam ? 'has-video' : ''} ${mine ? 'me' : ''}" data-id="${esc(id)}"><video autoplay playsinline ${mine ? 'muted' : ''}></video><div class="nx-face" style="--c:${avColor(name)}">${pic ? `<img src="${esc(pic)}" alt="">` : esc(initials(mine ? HC.state.user?.name : name))}</div><div class="nx-name">${p.mic ? '' : icon(I.micOff, 13)}<span>${esc(name)}</span>${stateText(p) ? `<em>${stateText(p)}</em>` : ''}</div></div>`;
  }
  function draw() {
    syncButtons(); if (C.phase === 'idle') return;
    let st = $('#nxStage'); if (!st) { st = document.createElement('section'); st.id = 'nxStage'; st.className = 'nx-stage'; st.setAttribute('aria-label', 'Call'); document.body.appendChild(st); clearInterval(C.tick); C.tick = setInterval(() => { const t = $('#nxClock'); if (t) t.textContent = clock(); }, 1000); }
    const ids = [...C.peers.keys()]; const keep = new Map($$('.nx-tile', st).map((t) => [t.dataset.id, t]));
    st.classList.toggle('big', C.big); document.body.classList.toggle('nx-call-big', C.big);
    const head = `<header class="nx-head"><div><b>${esc(C.title || 'Call')}</b><small id="nxClock">${clock()}</small></div><button class="nx-mini" data-a="big" title="${C.big ? 'Smaller' : 'Full screen'}" aria-label="${C.big ? 'Smaller' : 'Full screen'}">${icon(C.big ? I.shrink : I.expand, 16)}</button></header>`;
    const bar = `<footer class="nx-bar"><button class="nx-btn ${C.mic ? '' : 'off'}" data-a="mic" title="${C.mic ? 'Mute' : 'Unmute'}" aria-label="${C.mic ? 'Mute' : 'Unmute'}" aria-pressed="${!C.mic}">${icon(C.mic ? I.mic : I.micOff)}</button>${C.video ? `<button class="nx-btn ${C.cam ? '' : 'off'}" data-a="cam" title="${C.cam ? 'Turn camera off' : 'Turn camera on'}" aria-label="Camera" aria-pressed="${!C.cam}">${icon(C.cam ? I.cam : I.camOff)}</button>` : ''}<button class="nx-btn" data-a="dev" title="Devices" aria-label="Choose devices">${icon(I.gear)}</button>${C.projectId ? `<button class="nx-btn" data-a="add" title="Invite teammates" aria-label="Invite teammates">${icon(I.add)}</button>` : ''}<button class="nx-btn no" data-a="end" title="Hang up" aria-label="Hang up">${icon(I.end)}</button></footer>`;
    // Tiles are kept between redraws so their <video> elements (bound to Nexconn streams) are not recreated.
    if (!$('.nx-grid', st)) st.innerHTML = `${head}<div class="nx-grid"></div>${bar}`; else { $('.nx-head', st).outerHTML = head; $('.nx-bar', st).outerHTML = bar; }
    const grid = $('.nx-grid', st); grid.style.setProperty('--n', String(ids.length + 1));
    for (const [id, el] of keep) if (id !== me() && !C.peers.has(id)) el.remove();
    for (const id of [me(), ...ids]) { const html = tile(id, id === me()); const old = keep.get(id); if (old) { const w = document.createElement('div'); w.innerHTML = html; const fresh = w.firstElementChild; old.className = fresh.className; $('.nx-name', old).replaceWith($('.nx-name', fresh)); $('.nx-face', old).replaceWith($('.nx-face', fresh)); } else grid.insertAdjacentHTML('beforeend', html); }
    bindVideo(st);
    $$('[data-a]', st).forEach((b) => { b.onclick = () => ({ mic: toggleMic, cam: toggleCam, dev: devices, add: inviteMore, end: hangup, big: () => { C.big = !C.big; draw(); } })[b.dataset.a]?.(); });
  }
  function bindVideo(st) {
    if (!C.video || !C.eng) return;
    const mine = $(`.nx-tile.me video`, st); if (mine && !mine.dataset.bound) { const r = C.eng.setLocalVideoView({ videoElement: mine }); if (r?.code === 0 || r?.code === undefined) mine.dataset.bound = '1'; }
    const views = $$('.nx-tile:not(.me) video', st).filter((v) => !v.dataset.bound && C.peers.get(v.closest('.nx-tile').dataset.id)?.state === C.K.NCCallUserState.ONCALL).map((v) => ({ userId: v.closest('.nx-tile').dataset.id, videoElement: v }));
    if (views.length) { const r = C.eng.setRemoteVideoView(views); if (r?.code === 0 || r?.code === undefined) views.forEach((v) => { v.videoElement.dataset.bound = '1'; }); }
  }
  function syncButtons() { const b = $('#callBtn'); if (b) { b.textContent = C.phase === 'idle' ? '● Call' : '● In call'; b.classList.toggle('in-call', C.phase !== 'idle'); } }

  // ---------- entry points ----------
  const projectMembers = (projectId) => (HC.hub?.hub?.projects?.find((p) => p.id === projectId)?.members || []).map((m) => m.nx);
  async function chooseAndCall(opts) {
    if (C.phase !== 'idle') { C.big = true; draw(); return; }
    modal({ title: opts.title, sub: opts.group ? 'Everyone on the project gets a ringing call. Anyone you miss can be invited from the call.' : '', width: 400, actions: [{ label: 'Cancel' }, { label: 'Voice call', id: 'voice', onClick: () => start({ ...opts, video: false }) }, { label: 'Video call', kind: 'primary', id: 'video', onClick: () => start({ ...opts, video: true }) }] });
  }
  /** The workspace's Call button: a group call with everyone on the open project. */
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('#callBtn'); if (!b) return; e.preventDefault(); e.stopImmediatePropagation();
    const p = HC.state.currentProject; if (!p) { notify('Open a project first'); return; }
    chooseAndCall({ userIds: projectMembers(p.id), title: `Call · ${p.name}`, group: true, projectId: p.id, targetId: HC.hub?.hub?.projects?.find((x) => x.id === p.id)?.channels.find((c) => c.key === 'general')?.id });
  }, true);
  HC.nxCall = {
    /** Called by the Team hub's call buttons. channel: { kind: 'direct', userId } or { kind: 'group', projectId, channelId, title }. */
    open(channel) {
      if (channel.kind === 'direct') chooseAndCall({ userIds: [channel.userId], title: nameOf(channel.userId), group: false, targetId: channel.userId });
      else chooseAndCall({ userIds: projectMembers(channel.projectId), title: channel.title, group: true, projectId: channel.projectId, targetId: channel.channelId });
    },
    state: C, start, hangup,
  };
  HC.joinCall = (projectId) => { const p = HC.hub?.hub?.projects?.find((x) => x.id === projectId); if (p) chooseAndCall({ userIds: projectMembers(projectId), title: `Call · ${p.name}`, group: true, projectId }); }; // inbox "Join" on older call notifications
  // The engine must exist before anyone calls us, so create it as soon as the Team hub is connected.
  const boot = setInterval(() => { if (engine()) clearInterval(boot); }, 1000);
  addEventListener('beforeunload', () => { if (C.callId) C.eng?.endCall({ callId: C.callId }); });
})();
