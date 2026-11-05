/* Motion layer: cursor spotlight on cards, button ripple, animated numbers, staggered lists. Pure polish; safe to delete. */
(() => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const CARD = '.card, .pcard, .stat, .tr-card, .gh-row, .event, .panel';
  document.addEventListener('pointermove', (e) => { const c = e.target.closest?.(CARD); if (!c) return; const r = c.getBoundingClientRect(); c.style.setProperty('--mx', `${e.clientX - r.left}px`); c.style.setProperty('--my', `${e.clientY - r.top}px`); }, { passive: true });
  document.addEventListener('pointerdown', (e) => { const b = e.target.closest?.('.primary-button, .outline-button, .icon-button'); if (!b) return; const r = b.getBoundingClientRect(); const s = document.createElement('span'); s.className = 'ripple'; const d = Math.max(r.width, r.height) * 2; s.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`; b.appendChild(s); setTimeout(() => s.remove(), 650); });
  const count = (el) => { const m = /^(\d[\d,]*)(.*)$/.exec(el.textContent.trim()); if (!m || el.dataset.counted === m[1]) return; const end = +m[1].replace(/,/g, ''); if (!end || end > 1e6) return; el.dataset.counted = m[1]; const t0 = performance.now(); const tick = (t) => { const k = Math.min(1, (t - t0) / 700); el.firstChild.nodeValue = Math.round(end * (1 - Math.pow(1 - k, 3))).toLocaleString() + m[2]; if (k < 1) requestAnimationFrame(tick); }; if (el.firstChild?.nodeType === 3) requestAnimationFrame(tick); };
  const stagger = (root) => root.querySelectorAll?.('.pgrid > *, .tr-grid > *, .project-list > *, .gh-list > *, .activity > *, .event-grid > *').forEach((el, i) => { if (el.dataset.in) return; el.dataset.in = 1; el.style.animationDelay = `${Math.min(i, 12) * 45}ms`; el.classList.add('in'); });
  new MutationObserver((muts) => { for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) { stagger(n.parentElement || n); n.querySelectorAll?.('.stat-value').forEach(count); if (n.matches?.('.stat-value')) count(n); } }).observe(document.body, { childList: true, subtree: true });
  stagger(document);
})();
