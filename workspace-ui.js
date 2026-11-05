/* Live workspace extras: fullscreen editor and zoom. */
(() => {
  const HC = window.HC; if (!HC) return; const $ = (s, r = document) => r.querySelector(s);
  const setFull = (on) => { document.body.classList.toggle('ide-full', on); if (on) document.documentElement.requestFullscreen?.().catch(() => {}); else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); const b = $('#ideFull'); if (b) { b.textContent = on ? '⤡ Exit full screen' : '⛶ Full screen'; b.setAttribute('aria-pressed', String(on)); } setTimeout(() => { window.dispatchEvent(new Event('resize')); HC.fitIde?.(); }, 120); };
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && document.body.classList.contains('ide-full')) setFull(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('ide-full') && !document.querySelector('.hc-modal')) setFull(false); if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f' && $('#ide')?.offsetParent) { e.preventDefault(); setFull(!document.body.classList.contains('ide-full')); } });
  const zoom = (d) => { const cur = HC.state.settings?.fontSize || 13; const next = d === 0 ? 13 : Math.max(9, Math.min(34, cur + d)); HC.saveSettings({ fontSize: next }); const l = $('#ideZoomLvl'); if (l) l.textContent = Math.round(next / 13 * 100) + '%'; };
  function inject() {
    const bar = $('#ide .room-actions'); if (!bar || $('#ideFull')) return;
    const z = document.createElement('div'); z.className = 'ide-zoom'; z.innerHTML = '<button type="button" id="ideZoomOut" title="Zoom out the editor text (Ctrl + mouse wheel)" aria-label="Zoom out">−</button><button type="button" id="ideZoomLvl" title="Reset zoom">100%</button><button type="button" id="ideZoomIn" title="Zoom in the editor text" aria-label="Zoom in">＋</button>';
    const f = document.createElement('button'); f.type = 'button'; f.id = 'ideFull'; f.className = 'outline-button'; f.title = 'Work full screen (Ctrl+Shift+F). Esc to exit'; f.textContent = '⛶ Full screen';
    bar.prepend(f); bar.prepend(z);
    $('#ideZoomOut').addEventListener('click', () => zoom(-1)); $('#ideZoomIn').addEventListener('click', () => zoom(1)); $('#ideZoomLvl').addEventListener('click', () => zoom(0)); f.addEventListener('click', () => setFull(!document.body.classList.contains('ide-full')));
    const l = $('#ideZoomLvl'); if (l) l.textContent = Math.round((HC.state.settings?.fontSize || 13) / 13 * 100) + '%';
  }
  new MutationObserver(inject).observe(document.body, { childList: true, subtree: true }); inject();
  setInterval(() => { const ed = HC.state.editor; if (ed && !ed.__zoomOn) { ed.__zoomOn = true; ed.updateOptions({ mouseWheelZoom: true }); ed.onDidChangeConfiguration?.(() => { const l = $('#ideZoomLvl'); const fs = ed.getOption?.(52); }); } }, 1500);
})();

// ---- sidebar line icons + sliding indicator for the right-hand tabs ----
(() => {
  const $ = (s, r = document) => r.querySelector(s); const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const svg = (p) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  function icons() { const I = window.HCIcons; if (!I) return; $$('.nav button[data-view]').forEach(b => { const k = b.dataset.view === 'project' ? 'projects' : b.dataset.view; const ic = $('.nav-icon', b); if (ic && I[k] && ic.dataset.done !== k) { ic.innerHTML = svg(I[k]); ic.dataset.done = k; } }); [['#inviteBtn', 'invite'], ['#settingsBtn', 'settings']].forEach(([sel, k]) => { const ic = $(`${sel} .nav-icon`); if (ic && ic.dataset.done !== k) { ic.innerHTML = svg(I[k]); ic.dataset.done = k; } }); }
  function indicator() { const bar = $('.side-tabs'); if (!bar) return; const on = $('button.on', bar), ind = $('.tab-ind', bar); if (!on || !ind) return; ind.style.width = on.offsetWidth + 'px'; ind.style.transform = `translateX(${on.offsetLeft}px)`; }
  document.addEventListener('click', (e) => { if (e.target.closest('.side-tabs button')) setTimeout(indicator, 0); });
  window.addEventListener('resize', indicator);
  new MutationObserver(() => { icons(); indicator(); }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] }); icons(); setInterval(indicator, 250); new ResizeObserver(() => indicator()).observe(document.body); document.fonts?.ready.then(indicator);
})();
