/* Experience layer: the sign-in showcase, card tilt, a "new project" tile, a scroll progress bar and a small celebration
   when something ships. Pure presentation: it reads the page, never the data. Safe to delete (remove fx.js and the
   "Experience layer" block at the end of app.css). */
(() => {
  const $ = (s, r = document) => r.querySelector(s); const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- sign-in showcase: what the product is, shown rather than told ----------
  const code = [
    ['<i class="k">export async function</i> <i class="f">joinRoom</i>(team) {', ''],
    ['  <i class="k">const</i> room = <i class="k">await</i> hack.<i class="f">connect</i>(team.id);', ''],
    ['  room.<i class="f">on</i>(<i class="s">\'edit\'</i>, syncEveryone);', 'maya'],
    ['  room.<i class="f">call</i>({ video: <i class="n">true</i> });', ''],
    ['  <i class="k">return</i> room.<i class="f">ship</i>();', 'arjun'],
    ['}', ''],
  ];
  function showcase(gate) {
    if (gate.dataset.fx || !$('.auth-card', gate)) return; gate.dataset.fx = '1';
    const el = document.createElement('div'); el.className = 'fx-show'; el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `<span class="fx-eyebrow"><i></i>Live now, for hackathon teams</span>
      <h1>Your whole team,<br><em>in one room.</em></h1>
      <p>Edit the same files together, talk it through on a call, ask one shared AI, and hand in a build the judges can replay.</p>
      <div class="fx-stage">
        <div class="fx-editor"><div class="fx-bar"><b></b><b></b><b></b><span>room.ts</span><em>3 editing</em></div>
          <div class="fx-code">${code.map(([line, who], i) => `<div class="fx-line${who ? ` has-${who}` : ''}"><u>${i + 1}</u><span>${line}</span>${who ? `<i class="fx-caret ${who}"><b>${who === 'maya' ? 'Maya' : 'Arjun'}</b></i>` : ''}</div>`).join('')}</div></div>
        <div class="fx-chip call"><span class="fx-wave"><i></i><i></i><i></i><i></i></span>Sara is talking <small>3 in call</small></div>
        <div class="fx-chip ai"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>AI proposed a change <small>Review diff</small></div>
      </div>
      <ul class="fx-points"><li>Live cursors and offline merge</li><li>Voice, video and screen share</li><li>Hackathons with judging and build replay</li></ul>`;
    gate.prepend(el); gate.classList.add('fx-split');
  }

  // ---------- "new project" tile at the end of the project grid ----------
  function newTile(grid) {
    if (!grid.closest('#projectsView') || $('.fx-new', grid) || !grid.children.length) return;
    const tile = document.createElement('button'); tile.type = 'button'; tile.className = 'fx-new'; tile.innerHTML = '<span>+</span><b>New project</b><small>Start a room, import a folder or a GitHub repo</small>';
    tile.addEventListener('click', () => ($('#newProjectBtn2') || $('#newProjectBtn'))?.click()); grid.appendChild(tile);
  }

  // ---------- a small celebration when something ships ----------
  const WIN = /\b(created|imported|submitted|published|joined|accepted|registered|invitation sent|connected)\b/i; const SAD = /\b(not|failed|could ?n[o']t|denied|error|cannot|removed|declined|cancelled)\b/i;
  function confetti() {
    if (calm) return; const c = document.createElement('canvas'); c.className = 'fx-confetti'; c.width = innerWidth; c.height = innerHeight; document.body.appendChild(c); const g = c.getContext('2d');
    const mint = getComputedStyle(document.documentElement).getPropertyValue('--mint').trim() || '#58e0aa'; const colors = [mint, '#f6a96c', '#7db7e8', '#ed9ac2', '#ecd77d'];
    const bits = Array.from({ length: 70 }, () => ({ x: innerWidth - 150 + (Math.random() - 0.5) * 90, y: innerHeight - 70, vx: (Math.random() - 0.72) * 11, vy: -(7 + Math.random() * 10), w: 5 + Math.random() * 5, h: 3 + Math.random() * 4, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, c: colors[(Math.random() * colors.length) | 0] }));
    const t0 = performance.now(); const tick = (t) => { const age = t - t0; g.clearRect(0, 0, c.width, c.height); for (const b of bits) { b.vy += 0.32; b.vx *= 0.992; b.x += b.vx; b.y += b.vy; b.r += b.vr; g.save(); g.globalAlpha = Math.max(0, 1 - age / 1700); g.translate(b.x, b.y); g.rotate(b.r); g.fillStyle = b.c; g.fillRect(-b.w / 2, -b.h / 2, b.w, b.h); g.restore(); } if (age < 1700) requestAnimationFrame(tick); else c.remove(); };
    requestAnimationFrame(tick);
  }
  const hookToast = () => { const base = window.toast; if (typeof base !== 'function' || base.fx) return false; let last = 0; const wrapped = (message) => { base(message); const text = String(message || ''); if (WIN.test(text) && !SAD.test(text) && Date.now() - last > 4000) { last = Date.now(); confetti(); } }; wrapped.fx = true; window.toast = wrapped; return true; };
  if (!hookToast()) { const wait = setInterval(() => { if (hookToast()) clearInterval(wait); }, 400); setTimeout(() => clearInterval(wait), 8000); }

  // ---------- gentle 3D tilt on the cards you can open ----------
  const TILT = '.pcard, .tr-card, .event, .fx-new';
  if (!calm && matchMedia('(hover: hover)').matches) {
    document.addEventListener('pointermove', (e) => { const card = e.target.closest?.(TILT); if (!card) return; const r = card.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width - 0.5; const py = (e.clientY - r.top) / r.height - 0.5; card.style.setProperty('--ry', `${(px * 5).toFixed(2)}deg`); card.style.setProperty('--rx', `${(-py * 5).toFixed(2)}deg`); card.classList.add('fx-tilt'); }, { passive: true });
    document.addEventListener('pointerout', (e) => { const card = e.target.closest?.(TILT); if (card && !card.contains(e.relatedTarget)) { card.style.removeProperty('--rx'); card.style.removeProperty('--ry'); } }, { passive: true });
  }

  // ---------- scroll progress along the top edge ----------
  const bar = document.createElement('div'); bar.className = 'fx-progress'; document.body.appendChild(bar);
  const onScroll = () => { const max = document.documentElement.scrollHeight - innerHeight; bar.style.transform = `scaleX(${max > 40 ? Math.min(1, scrollY / max) : 0})`; };
  addEventListener('scroll', onScroll, { passive: true }); addEventListener('resize', onScroll);

  // ---------- keep up with a page that redraws itself ----------
  const scan = () => { const gate = $('#authGate'); if (gate) showcase(gate); $$('#projectsView .pgrid').forEach(newTile); onScroll(); };
  let queued = false; new MutationObserver(() => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; scan(); }); }).observe(document.body, { childList: true, subtree: true });
  scan();
})();
