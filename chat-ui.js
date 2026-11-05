/* Chat extras: emoji picker, stickers, message reactions. */
(() => {
  const HC = window.HC; if (!HC) return; const { api, esc, notify } = HC; const $ = (s, r = document) => r.querySelector(s); const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const EMOJI = { 'Smileys': '😀 😁 😂 🤣 😊 😍 🤩 😎 🤔 😅 😭 😴 🥳 🤯 😇 🙃', 'Hands': '👍 👎 👏 🙌 🙏 💪 👋 🤝 ✌️ 🤞 👀 🫡', 'Dev': '💻 🐛 🔥 🚀 ✅ ❌ ⚡ 🧠 🛠️ 📦 🔒 🧪 📈 💡 🎯 ⏰', 'Party': '🎉 🏆 🥇 🍕 ☕ 🍿 🎮 🎧 ❤️ 💜 💚 ✨' };
  const STICKERS = ['🚀', '🎉', '🔥', '💯', '🤝', '👏', '😂', '🐛', '☕', '🏆', '🤯', '🫶'];
  const QUICK = ['👍', '❤️', '😂', '🎉', '🚀', '👀'];
  const pid = () => HC.state.currentProject?.id;
  const post = (text, sticker = false) => pid() && api(`/projects/${pid()}/messages`, { method: 'POST', body: JSON.stringify({ text, sticker }) }).catch(e => notify(e.message));
  const closePop = () => { $('#chatPop')?.remove(); document.removeEventListener('pointerdown', outside, true); };
  const outside = (e) => { if (!e.target.closest('#chatPop, #emojiBtn, #stickerBtn, .rx.add')) closePop(); };
  function pop(anchor, html, place = 'above') { const same = $('#chatPop')?._anchor === anchor; closePop(); if (same) return document.createElement('div'); /* clicking the same button again closes the picker */ const p = document.createElement('div'); p._anchor = anchor; p.id = 'chatPop'; p.className = 'chat-pop'; p.innerHTML = html; document.body.appendChild(p); const r = anchor.getBoundingClientRect(); const pw = p.offsetWidth, ph = p.offsetHeight; p.style.left = Math.max(8, Math.min(innerWidth - pw - 8, r.right - pw)) + 'px'; p.style.top = (place === 'above' ? Math.max(8, r.top - ph - 8) : Math.min(innerHeight - ph - 8, r.bottom + 6)) + 'px'; setTimeout(() => document.addEventListener('pointerdown', outside, true)); return p; }
  function enhance() {
    const form = $('#chatForm'); if (!form || $('#emojiBtn', form)) return; const input = $('#chatMessage', form); const send = $('button', form);
    const mk = (id, label, title) => { const b = document.createElement('button'); b.type = 'button'; b.id = id; b.className = 'chat-ic'; b.title = title; b.setAttribute('aria-label', title); b.textContent = label; return b; };
    const emo = mk('emojiBtn', '😊', 'Emoji'); const stk = mk('stickerBtn', '🎟', 'Stickers'); form.insertBefore(emo, send); form.insertBefore(stk, send);
    emo.addEventListener('click', () => { const p = pop(emo, Object.entries(EMOJI).map(([g, list]) => `<div class="pop-h">${g}</div><div class="pop-grid">${list.split(' ').map(x => `<button type="button" data-e="${x}">${x}</button>`).join('')}</div>`).join('')); $$('[data-e]', p).forEach(b => b.addEventListener('click', () => { const s = input.selectionStart ?? input.value.length; input.value = input.value.slice(0, s) + b.dataset.e + input.value.slice(s); input.focus(); const at = s + b.dataset.e.length; input.setSelectionRange(at, at); })); });
    stk.addEventListener('click', () => { const p = pop(stk, `<div class="pop-h">Stickers: click to send</div><div class="pop-grid big">${STICKERS.map(x => `<button type="button" data-s="${x}">${x}</button>`).join('')}</div>`); $$('[data-s]', p).forEach(b => b.addEventListener('click', () => { post(b.dataset.s, true); closePop(); })); });
  }
  new MutationObserver(enhance).observe(document.body, { childList: true, subtree: true }); enhance();
  // reactions (event delegation: messages are re-rendered often)
  document.addEventListener('click', async (e) => {
    const msg = e.target.closest?.('#messages .message'); if (!msg) return; const id = msg.dataset.messageId;
    const react = async (emoji) => { try { await api(`/projects/${pid()}/messages/${encodeURIComponent(id)}/react`, { method: 'POST', body: JSON.stringify({ emoji }) }); } catch (err) { notify(err.message); } };
    const chip = e.target.closest('[data-react]'); if (chip) { react(chip.dataset.react); return; }
    const add = e.target.closest('[data-react-pick]'); if (add) { const p = pop(add, `<div class="pop-grid quick">${QUICK.map(x => `<button type="button" data-q="${x}">${x}</button>`).join('')}</div>`, 'below'); $$('[data-q]', p).forEach(b => b.addEventListener('click', () => { react(b.dataset.q); closePop(); })); }
  });
})();
