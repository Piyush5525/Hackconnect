/* HackConnect's browser adapter. The original visual prototype stays in index.html;
   this file replaces its local-only interactions with the local API and realtime room. */
(() => {
  if (location.protocol === 'file:') { location.replace('http://localhost:4173/'); return; } // the API lives on the HackConnect server, not in a file
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const api = (path, options = {}) => fetch(`/api${path}`, { credentials: 'same-origin', ...options, headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect', ...(options.headers || {}) } }).catch(() => { throw new Error(`Cannot reach the HackConnect server at ${location.origin}. Start it (npm start, or double-click start-hackconnect.cmd) and open http://localhost:4173`); }).then(async response => { const body = await response.json().catch(() => ({})); if (response.status === 401 && !path.startsWith('/auth/')) { showAuth(); throw new Error('Please sign in to continue'); } if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`); return body; });
  const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
  const notify = (message) => { if (typeof window.toast === 'function') window.toast(message); else { const toast = $('#toast'); toast.textContent = message; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2500); } };
  const state = { projects: [], activity: [], currentProject: null, socket: null, saveTimer: null, localStream: null, peers: new Map(), collab: null, unbind: null, editor: null, unbindPreview: null, activePath: null, following: null, user: null };
  // ===================== IDE layer: dialogs, avatars, explorer, tabs, assistant, extensions =====================
  const hashHue = (value) => { let h = 0; for (const ch of String(value)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 360; };
  const avColor = (seed) => `hsl(${hashHue(seed)} 62% 64%)`;
  const av = (person, size = 30) => person.avatar ? `<span class="av has-img" style="--s:${size}px;background-image:url('${esc(person.avatar)}')" title="${esc(person.name || '')}${person.username ? ` (@${esc(person.username)})` : ''}"></span>` : `<span class="av" style="--s:${size}px;--c:${avColor(person.username || person.name || person.id || '?')}" title="${esc(person.name || '')}${person.username ? ` (@${esc(person.username)})` : ''}">${esc((person.initials || String(person.name || '?').slice(0, 2)).toUpperCase())}</span>`;
  const ago = (ms) => { if (!ms) return 'never'; const s = Math.max(1, Math.round((Date.now() - ms) / 1000)); if (s < 60) return 'just now'; const m = Math.round(s / 60); if (m < 60) return `${m} min ago`; const h = Math.round(m / 60); if (h < 24) return `${h} h ago`; const d = Math.round(h / 24); return d < 30 ? `${d} d ago` : new Date(ms).toLocaleDateString(); };

  function modal({ title, sub = '', body = '', actions = [], width = 520, onClose } = {}) {
    const wrap = document.createElement('div'); wrap.className = 'hc-modal'; wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true'); wrap.setAttribute('aria-label', title || 'Dialog');
    wrap.innerHTML = `<div class="hc-card" style="--w:${width}px">${title ? `<h2>${esc(title)}</h2>` : ''}${sub ? `<p class="sub">${sub}</p>` : ''}<div class="hc-body">${body}</div>${actions.length ? '<div class="hc-actions"></div>' : ''}</div>`;
    const previous = document.activeElement; const close = () => { document.removeEventListener('keydown', onKey, true); wrap.remove(); onClose?.(); previous?.focus?.(); };
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true); wrap.addEventListener('mousedown', (event) => { if (event.target === wrap) close(); });
    const bar = $('.hc-actions', wrap); actions.forEach(action => { const button = document.createElement('button'); button.type = 'button'; button.className = action.kind === 'primary' ? 'primary-button' : `outline-button${action.kind === 'danger' ? ' btn-danger' : ''}`; button.textContent = action.label; button.addEventListener('click', async () => { if (button.disabled) return; button.disabled = true; try { const keep = await action.onClick?.(close, wrap); if (keep === false) button.disabled = false; else if (!action.keepOpen) close(); } catch (error) { notify(error.message); button.disabled = false; } }); button.dataset.act = action.id || ''; bar.appendChild(button); });
    document.body.appendChild(wrap); (wrap.querySelector('[autofocus]') || wrap.querySelector('input,select,textarea,button'))?.focus(); return { el: wrap, close, $: (sel) => $(sel, wrap), $$: (sel) => $$(sel, wrap) };
  }
  function ask(title, label, value = '', { placeholder = '', confirm = 'Save', sub = '', multiline = false } = {}) {
    return new Promise(resolve => { let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const m = modal({ title, sub, width: 440, body: `<label class="hc-field">${esc(label)}${multiline ? `<textarea class="inp" id="askInput" rows="4" autofocus placeholder="${esc(placeholder)}">${esc(value)}</textarea>` : `<input class="inp" id="askInput" autofocus autocomplete="off" placeholder="${esc(placeholder)}" value="${esc(value)}">`}</label>`, onClose: () => finish(null),
        actions: [{ label: 'Cancel', onClick: () => finish(null) }, { label: confirm, kind: 'primary', id: 'ok', onClick: () => { finish(m.$('#askInput').value.trim()); } }] });
      const input = m.$('#askInput'); input.select?.(); input.addEventListener('keydown', e => { if (e.key === 'Enter' && !multiline) { e.preventDefault(); m.$('[data-act=ok]').click(); } }); });
  }
  function confirmBox(title, message, { confirm = 'Confirm', danger = false } = {}) {
    return new Promise(resolve => { let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
      modal({ title, sub: message, width: 440, onClose: () => finish(false), actions: [{ label: 'Cancel', onClick: () => finish(false) }, { label: confirm, kind: danger ? 'danger' : 'primary', onClick: () => finish(true) }] }); });
  }
  const copyText = async (text) => { try { await navigator.clipboard.writeText(text); notify('Copied to clipboard'); } catch { window.prompt('Copy this', text); } };

  // ---------- editor settings (the "extensions" that change how the editor behaves) ----------
  const SETTINGS_KEY = 'hc-editor-settings';
  const DEFAULT_SETTINGS = { theme: 'hackconnect', fontSize: 13, tabSize: 2, minimap: false, wordWrap: true, ligatures: false, brackets: true, smoothCaret: false, whitespace: false, formatOnSave: false };
  const loadSettings = () => { try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return { ...DEFAULT_SETTINGS }; } };
  state.settings = loadSettings();
  const applySettings = () => { if (state.editor && window.HCCollab?.applyEditorOptions) HCCollab.applyEditorOptions(state.editor, state.settings); };
  const saveSettings = (patch) => { state.settings = { ...state.settings, ...patch }; localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); applySettings(); };

  // ---------- skeleton ----------
  function buildIde() {
    const view = $('#workspaceView'); if (!view) return;
    view.innerHTML = `<div class="ide" id="ide">
      <header class="ide-top"><div class="ide-title"><h1 id="wsTitle">Live workspace</h1><span class="status" id="wsRole">Live</span><span class="muted small" id="wsSub"></span></div>
        <div class="room-actions"><button class="outline-button" id="wsPageBtn" title="Project page: README, languages, contributors">▦ Project page</button><button class="outline-button" id="wsInviteBtn" title="Invite people by username">＋ Invite</button><button class="outline-button" id="wsGithubBtn" title="Sync to GitHub">↥ GitHub</button><button class="outline-button" id="wsExtBtn" title="Editor settings, extensions and downloads">◫ Extensions</button><button class="outline-button" id="wsMoreBtn" title="More: full screen, zoom, GitHub, extensions" aria-haspopup="menu" aria-label="More">⋯</button><button class="outline-button" id="shareBtn" title="Share a view or edit link">↗ Share</button></div></header>
      <div class="ide-body" id="ideBody">
        <aside class="file-panel" aria-label="Explorer"><div class="file-header"><span>EXPLORER</span><span class="ib"><button id="newFileBtn" title="New file" aria-label="New file" data-tip="New file"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11.5v5M9.5 14h5"/></svg></button><button id="newFolderBtn" title="New folder" aria-label="New folder" data-tip="New folder"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10.5v5M9.5 13h5"/></svg></button><button id="importBtn" title="Import files, a folder, a zip or a GitHub repo" aria-label="Import" data-tip="Import / upload"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V4M8 8l4-4 4 4"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg></button><button id="collapseBtn" title="Collapse all folders" aria-label="Collapse all folders" data-tip="Collapse all"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7l5 5 5-5M7 13l5 5 5-5" transform="rotate(180 12 12)"/></svg></button></span></div><div class="ftree" id="ftree" role="tree"></div></aside>
        <div class="splitter" data-side="left" role="separator" aria-orientation="vertical"></div>
        <section class="editor-panel"><div class="editor-top"><div class="tab-strip" id="tabStrip" role="tablist"></div><span id="activeFile" class="sr-only"></span><div class="save-state" id="saveState">Open a project to start</div></div>
          <div class="code-area"><div class="line-numbers" id="lineNumbers" style="display:none"></div><textarea id="codeInput" spellcheck="false" style="display:none"></textarea></div>
          <div class="statusbar" id="statusBar" role="status"></div></section>
        <div class="splitter" data-side="right" role="separator" aria-orientation="vertical"></div>
        <aside class="collab-panel" aria-label="Assistant and chat"><div class="side-tabs" role="tablist"><i class="tab-ind" aria-hidden="true"></i><button data-pane="assistant" class="on" role="tab"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/></svg><span>Assistant</span></button><button data-pane="chat" role="tab"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg><span>Chat</span> <span class="badge" id="chatBadge" hidden>0</span></button><button data-pane="people" role="tab"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/></svg><span>People</span></button></div>
          <div class="pane" id="paneAssistant"></div>
          <div class="pane" id="paneChat" hidden><div class="chat"><div class="messages" id="messages" aria-live="polite"></div><form class="chat-input" id="chatForm"><input id="chatMessage" aria-label="Message" placeholder="Message the room…" autocomplete="off"><button aria-label="Send">↑</button></form></div></div>
          <div class="pane" id="panePeople" hidden><div class="presence"><div class="presence-label">In this room</div><div id="presenceList"></div></div><div style="padding:14px;overflow:auto;flex:1" id="memberList"></div><div id="voiceChannels"></div></div>
        </aside></div></div>`;
    const body = $('#ideBody'); body.style.setProperty('--left', `${Number(localStorage.getItem('hc-ide-left')) || 250}px`); body.style.setProperty('--right', `${Number(localStorage.getItem('hc-ide-right')) || 370}px`);
    $$('.splitter', body).forEach(handle => handle.addEventListener('mousedown', event => { event.preventDefault(); const side = handle.dataset.side; handle.classList.add('drag'); const startX = event.clientX; const startW = Number(getComputedStyle(body).getPropertyValue(`--${side}`).replace('px', '')) || (side === 'left' ? 250 : 370);
      const move = e => { const delta = e.clientX - startX; const w = Math.min(side === 'left' ? 480 : 640, Math.max(side === 'left' ? 170 : 280, side === 'left' ? startW + delta : startW - delta)); body.style.setProperty(`--${side}`, `${w}px`); };
      const up = () => { handle.classList.remove('drag'); localStorage.setItem(`hc-ide-${side}`, parseInt(getComputedStyle(body).getPropertyValue(`--${side}`))); document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); }; document.addEventListener('mousemove', move); document.addEventListener('mouseup', up); }));
    $$('.side-tabs button').forEach(button => button.addEventListener('click', () => showPane(button.dataset.pane)));
    $('#wsPageBtn').addEventListener('click', () => state.currentProject && window.HC.openProjectPage?.(state.currentProject.id));
    $('#wsInviteBtn').addEventListener('click', () => state.currentProject && openInvite(state.currentProject.id));
    $('#wsGithubBtn').addEventListener('click', syncGithub); $('#wsExtBtn').addEventListener('click', () => openExtensions());
    $('#shareBtn').addEventListener('click', openShare); $('#wsMoreBtn').addEventListener('click', openMore); $('#newFileBtn').addEventListener('click', () => createFile('')); $('#newFolderBtn').addEventListener('click', () => createFolder(''));
    $('#importBtn').addEventListener('click', () => state.currentProject && window.HC.openImport?.(state.currentProject.id));
    $('#collapseBtn').addEventListener('click', () => { state.openDirs.clear(); renderExplorer(state.activePath); });
    const tree = $('#ftree'); tree.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); tree.classList.add('over'); } }); tree.addEventListener('dragleave', () => tree.classList.remove('over'));
    tree.addEventListener('drop', e => { if (!e.dataTransfer?.files?.length) return; e.preventDefault(); tree.classList.remove('over'); state.currentProject && window.HC.importFileList?.(state.currentProject.id, e.dataTransfer); });
    renderStatusBar();
  }
  state.openDirs = new Set(); state.tabs = []; state.pane = 'assistant'; state.thread = []; state.chatUnread = 0; state.online = [];
  const showPane = (pane) => { state.pane = pane; $$('.side-tabs button').forEach(b => b.classList.toggle('on', b.dataset.pane === pane)); for (const [name, id] of [['assistant', '#paneAssistant'], ['chat', '#paneChat'], ['people', '#panePeople']]) { const el = $(id); if (el) el.hidden = name !== pane; } if (pane === 'chat') { state.chatUnread = 0; const badge = $('#chatBadge'); if (badge) badge.hidden = true; const m = $('#messages'); if (m) m.scrollTop = m.scrollHeight; $('#chatMessage')?.focus(); } if (pane === 'people') renderMembers(); if (pane === 'assistant') $('#agentPrompt')?.focus(); };
  const bumpChat = () => { if (state.pane === 'chat') return; state.chatUnread++; const badge = $('#chatBadge'); if (badge) { badge.hidden = false; badge.textContent = state.chatUnread > 9 ? '9+' : state.chatUnread; } };
  function fitIde() { document.body.classList.toggle('ws-active', Boolean($('#workspaceView')?.classList.contains('active'))); const ide = $('#ide'); if (!ide || !ide.offsetParent) return; const top = ide.getBoundingClientRect().top + window.scrollY; ide.style.height = `${Math.max(520, window.innerHeight - (top - window.scrollY) - 14)}px`; }
  window.addEventListener('resize', fitIde); new MutationObserver(() => requestAnimationFrame(fitIde)).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class', 'hidden'], childList: true });
  const canWrite = () => state.currentProject && state.currentProject.role !== 'viewer' && !state.currentProject.frozen;

  // ---------- explorer (nested tree + file operations) ----------
  const ICONS = { js: ['JS', '#f1e05a'], mjs: ['JS', '#f1e05a'], jsx: ['JSX', '#f1e05a'], ts: ['TS', '#3178c6'], tsx: ['TSX', '#3178c6'], py: ['PY', '#3572A5'], html: ['<>', '#e34c26'], css: ['#', '#a78bfa'], scss: ['#', '#c6538c'], json: ['{}', '#cbcb41'], md: ['M↓', '#9aa8a1'], go: ['GO', '#00ADD8'], rs: ['RS', '#dea584'], java: ['J', '#b07219'], rb: ['RB', '#701516'], php: ['PHP', '#4F5D95'], sh: ['$', '#89e051'], yml: ['Y', '#cb171e'], yaml: ['Y', '#cb171e'], svg: ['◇', '#ff9900'], txt: ['≡', '#9aa8a1'], vue: ['V', '#41b883'], sql: ['DB', '#e38c00'], c: ['C', '#555'], cpp: ['C+', '#f34b7d'], cs: ['C#', '#178600'] };
  const FOLDER_ICON = '<svg class="ticon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="#8fa59a" d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3.2c.4 0 .8.2 1.1.5L8.5 4H13a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5z"/></svg>';
  const iconFor = (name) => { const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : ''; const [text, color] = ICONS[ext] || ['•', '#6b7a73']; return `<span class="ticon" style="color:${color};font-size:${text.length > 2 ? 8 : 10}px;font-weight:800">${esc(text)}</span>`; };
  function buildTree(paths) {
    const root = { dir: true, path: '', children: new Map() };
    for (const path of paths) { const parts = path.split('/'); let node = root; parts.forEach((part, index) => { const last = index === parts.length - 1; const key = parts.slice(0, index + 1).join('/'); if (!node.children.has(part)) node.children.set(part, { name: part, path: key, dir: !last, children: new Map() }); node = node.children.get(part); if (!last) node.dir = true; }); }
    return root;
  }
  const sortedChildren = (node) => [...node.children.values()].sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  function renderExplorer(selected) {
    const tree = $('#ftree'); const project = state.currentProject; if (!tree) return; if (!project) { tree.innerHTML = '<div class="empty" style="margin:12px;padding:20px">Open a project from <b>My projects</b> to see its files.</div>'; return; }
    const paths = Object.keys(project.files || {}).sort(); state.tabs = state.tabs.filter(p => paths.includes(p));
    const root = buildTree(paths); if (!state.dirsInit || state.dirsInit !== project.id) { state.dirsInit = project.id; state.openDirs = new Set(); const expand = (n, depth) => { for (const c of n.children.values()) if (c.dir && (paths.length < 80 || depth < 1)) { state.openDirs.add(c.path); expand(c, depth + 1); } }; expand(root, 0); }
    if (selected) { const parts = selected.split('/'); for (let i = 1; i < parts.length; i++) state.openDirs.add(parts.slice(0, i).join('/')); }
    const rows = []; const walk = (node, depth) => { for (const child of sortedChildren(node)) { const open = state.openDirs.has(child.path); rows.push(`<div class="trow ${child.path === selected && !child.dir ? 'selected' : ''}" role="treeitem" data-path="${esc(child.path)}" data-dir="${child.dir ? 1 : 0}" style="--d:${depth}" tabindex="0" ${child.dir ? `aria-expanded="${open}"` : ''}>${child.dir ? `<span class="chev ${open ? 'open' : ''}">▶</span>${FOLDER_ICON}` : `<span class="chev"></span>${iconFor(child.name)}`}<span class="nm">${esc(child.name)}</span><button class="more" aria-label="Actions" data-more>⋯</button></div>`); if (child.dir && open) walk(child, depth + 1); } }; walk(root, 0);
    tree.innerHTML = rows.join('') || '<div class="empty" style="margin:12px;padding:20px">This workspace is empty.<br><br><button class="primary-button btn-sm" id="emptyImport">Import files</button></div>';
    $('#emptyImport')?.addEventListener('click', () => window.HC.openImport?.(project.id));
    $$('.trow', tree).forEach(row => { const path = row.dataset.path; const isDir = row.dataset.dir === '1';
      row.addEventListener('click', e => { if (e.target.closest('[data-more]')) { e.stopPropagation(); showTreeMenu(e.clientX, e.clientY, path, isDir); return; } if (isDir) { state.openDirs.has(path) ? state.openDirs.delete(path) : state.openDirs.add(path); renderExplorer(state.activePath); } else { state.following = null; selectFile(path); } });
      row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); } if (e.key === 'F2') renameEntry(path, isDir); if (e.key === 'Delete') deleteEntry(path, isDir); });
      row.addEventListener('contextmenu', e => { e.preventDefault(); showTreeMenu(e.clientX, e.clientY, path, isDir); }); });
    tree.addEventListener('contextmenu', e => { if (e.target === tree) { e.preventDefault(); showTreeMenu(e.clientX, e.clientY, '', true); } }, { once: true });
    $('#newFileBtn') && ($('#newFileBtn').disabled = !canWrite()); $('#newFolderBtn') && ($('#newFolderBtn').disabled = !canWrite()); $('#importBtn') && ($('#importBtn').disabled = !canWrite());
    renderTabs();
  }
  function showTreeMenu(x, y, path, isDir) {
    $('.ctx')?.remove(); const menu = document.createElement('div'); menu.className = 'ctx'; menu.setAttribute('role', 'menu'); const w = canWrite(); const dir = isDir ? path : path.split('/').slice(0, -1).join('/');
    menu.innerHTML = `${w ? `<button data-a="file">New file${dir ? ` in ${esc(dir.split('/').pop())}` : ''}</button><button data-a="folder">New folder</button><button data-a="import">Import here…</button><div class="sep"></div>${path ? '<button data-a="rename">Rename</button>' : ''}` : ''}${path ? `<button data-a="copy">Copy path</button>` : ''}${w && path ? '<button data-a="delete" class="danger">Delete</button>' : ''}${!path && !w ? '<button disabled>Read-only workspace</button>' : ''}`;
    document.body.appendChild(menu); menu.style.left = `${Math.min(x, innerWidth - 210)}px`; menu.style.top = `${Math.min(y, innerHeight - menu.offsetHeight - 10)}px`;
    const close = () => { menu.remove(); document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', esc2, true); }; const outside = e => { if (!menu.contains(e.target)) close(); }; const esc2 = e => { if (e.key === 'Escape') close(); };
    setTimeout(() => { document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', esc2, true); }); menu.addEventListener('click', e => { const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return; close(); if (a === 'file') createFile(dir); else if (a === 'folder') createFolder(dir); else if (a === 'import') window.HC.openImport?.(state.currentProject.id); else if (a === 'rename') renameEntry(path, isDir); else if (a === 'copy') copyText(path); else if (a === 'delete') deleteEntry(path, isDir); });
  }
  const joinPath = (dir, name) => [dir, name].filter(Boolean).join('/').replace(/\/+/g, '/');
  async function createFile(dir = '') { if (!canWrite()) return notify(state.currentProject?.frozen ? 'This workspace is frozen' : 'You have view-only access'); const name = await ask('New file', `Name${dir ? ` (inside ${dir})` : ''}`, '', { placeholder: 'notes.md or src/app.js', confirm: 'Create' }); if (!name) return; const path = joinPath(dir, name); try { await api(`/projects/${state.currentProject.id}/files`, { method: 'PUT', body: JSON.stringify({ path, content: '' }) }); state.currentProject.files[path] ??= ''; if (dir) state.openDirs.add(dir); renderExplorer(path); selectFile(path); } catch (error) { notify(error.message); } }
  async function createFolder(dir = '') { if (!canWrite()) return; const name = await ask('New folder', `Name${dir ? ` (inside ${dir})` : ''}`, '', { placeholder: 'components', confirm: 'Create' }); if (!name) return; const path = joinPath(dir, name); try { await api(`/projects/${state.currentProject.id}/files/mkdir`, { method: 'POST', body: JSON.stringify({ path }) }); state.currentProject.files[`${path}/.gitkeep`] ??= ''; state.openDirs.add(path); renderExplorer(state.activePath); } catch (error) { notify(error.message); } }
  async function renameEntry(path, isDir) { const to = await ask(isDir ? 'Rename folder' : 'Rename file', 'New path', path, { confirm: 'Rename' }); if (!to || to === path) return; try { await api(`/projects/${state.currentProject.id}/files/rename`, { method: 'POST', body: JSON.stringify({ from: path, to }) }); const files = state.currentProject.files; for (const key of Object.keys(files)) if (key === path || key.startsWith(`${path}/`)) { files[to + key.slice(path.length)] = files[key]; delete files[key]; } state.tabs = state.tabs.map(t => (t === path || t.startsWith(`${path}/`)) ? to + t.slice(path.length) : t); if (state.activePath === path || state.activePath?.startsWith(`${path}/`)) { const next = to + state.activePath.slice(path.length); renderExplorer(next); selectFile(next); } else renderExplorer(state.activePath); } catch (error) { notify(error.message); } }
  async function deleteEntry(path, isDir) { const ok = await confirmBox(isDir ? 'Delete folder?' : 'Delete file?', `${isDir ? 'Everything inside ' : ''}"${path}" will be removed for everyone in this workspace. The build replay keeps the history.`, { confirm: 'Delete', danger: true }); if (!ok) return; try { await api(`/projects/${state.currentProject.id}/files?path=${encodeURIComponent(path)}${isDir ? '&folder=1' : ''}`, { method: 'DELETE' }); const files = state.currentProject.files; for (const key of Object.keys(files)) if (key === path || (isDir && key.startsWith(`${path}/`))) delete files[key]; state.tabs = state.tabs.filter(t => t !== path && !(isDir && t.startsWith(`${path}/`))); if (state.activePath === path || (isDir && state.activePath?.startsWith(`${path}/`))) { const next = state.tabs.at(-1) || Object.keys(files).sort()[0] || null; renderExplorer(next); if (next) selectFile(next); else { state.activePath = null; $('#activeFile').textContent = ''; state.unbind?.(); state.unbind = null; state.editor?.setModel(null); renderTabs(); renderStatusBar(); } } else renderExplorer(state.activePath); } catch (error) { notify(error.message); } }

  // ---------- tabs + status bar ----------
  function renderTabs() {
    const strip = $('#tabStrip'); if (!strip) return; if (state.activePath && !state.tabs.includes(state.activePath) && state.currentProject?.files?.[state.activePath] !== undefined) state.tabs.push(state.activePath);
    strip.innerHTML = state.tabs.map(path => `<div class="tabx ${path === state.activePath ? 'on' : ''}" role="tab" data-path="${esc(path)}" title="${esc(path)}" aria-selected="${path === state.activePath}">${iconFor(path.split('/').pop())}<span>${esc(path.split('/').pop())}</span><button aria-label="Close ${esc(path)}" data-x>×</button></div>`).join('');
    $$('.tabx', strip).forEach(tab => { const path = tab.dataset.path; tab.addEventListener('click', e => { if (e.target.closest('[data-x]')) { closeTab(path); return; } state.following = null; selectFile(path); }); tab.addEventListener('auxclick', e => { if (e.button === 1) closeTab(path); }); });
    $('.tabx.on', strip)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }
  function closeTab(path) { const i = state.tabs.indexOf(path); if (i < 0) return; state.tabs.splice(i, 1); if (state.activePath === path) { const next = state.tabs[i] || state.tabs[i - 1]; if (next) selectFile(next); else { state.activePath = null; $('#activeFile').textContent = ''; state.unbind?.(); state.unbind = null; state.editor?.setModel(null); renderTabs(); renderStatusBar(); } } else renderTabs(); }
  function renderStatusBar(position) {
    const bar = $('#statusBar'); if (!bar) return; const p = state.currentProject; const pos = position || (state.editor && window.HCCollab?.currentPosition ? HCCollab.currentPosition(state.editor) : null); const model = state.editor?.getModel?.(); const lang = model?.getLanguageId?.() || '';
    bar.innerHTML = `<span>${p ? `<b>${esc(p.name)}</b>` : 'No project'}</span>${state.activePath ? `<span>${esc(lang || 'plaintext')}</span>` : ''}${pos && state.activePath ? `<span>Ln ${pos.line}, Col ${pos.column}</span>` : ''}<span>Spaces: ${state.settings.tabSize}</span><span>LF · UTF-8</span><span class="grow"></span>${p?.role === 'viewer' ? '<span class="chip warn">view only</span>' : ''}${p?.frozen ? '<span class="chip warn">frozen</span>' : ''}<span>${state.online.length || (p ? 1 : 0)} online</span><span>${esc(state.connLabel || '')}</span>`;
  }

  // ---------- project open / selectFile ----------
  function renderWorkspace(project, messages = []) {
    const first = Object.keys(project.files || {}).sort().find(f => /readme/i.test(f)) || Object.keys(project.files || {}).sort()[0] || null; state.activePath = first; state.tabs = first ? [first] : [];
    $('#wsTitle').textContent = project.name; $('#wsSub').textContent = project.description || ''; $('#wsRole').textContent = project.frozen ? 'Frozen' : project.role === 'viewer' ? 'View only' : 'Live';
    renderExplorer(first); $('#activeFile').textContent = first || ''; ensureMonaco();
    if (state.editor && first) { state.unbindPreview?.(); state.unbindPreview = HCCollab.previewFile(state.editor, first, project.files[first] || '', true); } else if (!state.editor) { $('#codeInput').style.display = ''; $('#codeInput').value = first ? project.files[first] || '' : ''; $('#codeInput').readOnly = project.role === 'viewer'; }
    renderMessages(messages); ensureAgentPanel(); connectRoom(project.id); connectCollab(project); loadProposals(); loadTunnels(); showPane(state.pane); renderStatusBar(); renderMembers(); refreshAssistMode();
  }
  function selectFile(path, keepFollow = false) {
    if (!keepFollow) state.following = null; state.activePath = path; if (!state.tabs.includes(path)) state.tabs.push(path); $('#activeFile').textContent = path;
    $$('.trow').forEach(row => row.classList.toggle('selected', row.dataset.path === path && row.dataset.dir === '0')); renderTabs();
    if (state.collab?.isSynced()) bindActive(); else { const text = state.currentProject?.files?.[path] || ''; if (state.editor) { state.unbindPreview?.(); state.unbindPreview = HCCollab.previewFile(state.editor, path, text, true); } else { $('#codeInput').value = text; } }
    sendPresence(path); renderStatusBar();
  }
  function ensureMonaco() {
    if (state.editor || !window.HCCollab?.createEditor) return state.editor; const area = $('.code-area'); if (!area) return null;
    const host = document.createElement('div'); host.id = 'monacoHost'; host.style.cssText = 'position:absolute;inset:0'; area.appendChild(host);
    try { state.editor = HCCollab.createEditor(host, { theme: state.settings.theme }); window.hcEditor = state.editor; applySettings(); state.editor.onDidChangeCursorPosition(e => renderStatusBar({ line: e.position.lineNumber, column: e.position.column })); } catch (error) { host.remove(); $('#codeInput').style.display = ''; notify('Rich editor unavailable, using the basic editor'); }
    return state.editor;
  }
  window.addEventListener('hc:save', async () => { if (state.settings.formatOnSave && state.editor && canWrite()) { try { await HCCollab.formatDocument(state.editor); } catch { /* language has no formatter */ } } const label = $('#saveState'); if (label) label.textContent = 'Saved · all changes synced'; });
  document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && $('#workspaceView')?.classList.contains('active')) { event.preventDefault(); window.dispatchEvent(new CustomEvent('hc:save')); } });

  // ---------- people ----------
  function updatePresence(members = []) {
    state.online = members; const label = $('.presence-label'); if (label) label.textContent = `In this room · ${members.length} online`; const list = $('#presenceList');
    if (list) list.innerHTML = members.map(m => `<div class="presence-row">${av({ name: m.name, initials: m.initials, id: m.id })}<span>${esc(m.name)}${m.id === state.user?.id ? ' <small class="muted">(you)</small>' : ''}<small style="display:block;color:var(--muted);margin:2px 0 0">${esc(m.file || 'browsing')}</small></span></div>`).join('') || '<div class="muted small">Nobody else is here yet.</div>';
    renderStatusBar();
  }
  const ROLE_LABEL = { owner: 'Owner', editor: 'Can edit', viewer: 'Can view' };
  async function renderMembers() {
    const box = $('#memberList'); if (!box || !state.currentProject) return; const pid = state.currentProject.id;
    try { const { members } = await api(`/projects/${pid}/members`); const me = members.find(m => m.id === state.user?.id); const owner = me?.role === 'owner';
      let pending = []; if (owner) { try { pending = (await api('/me/invitations')).sent.filter(i => i.target?.id === pid); } catch { /* optional */ } }
      const chip = (r) => `<span class="mem-role ${esc(r)}">${esc(ROLE_LABEL[r] || r)}</span>`;
      box.innerHTML = `<div class="panel-h" style="padding:0 0 10px;border:0"><b>Members (${members.length})</b>${owner ? '<button class="outline-button btn-sm" id="inviteMore">＋ Invite</button>' : ''}</div>`
        + members.map(m => `<div class="contrib mem">${av(m, 32)}<div class="who"><b>${esc(m.name || 'Unknown')}${m.id === state.user?.id ? ' <span class="muted">(you)</span>' : ''}</b><span>@${esc(m.username || '')}</span></div>${chip(m.role)}${owner && m.id !== state.user.id ? `<button class="mem-more" data-mm="${esc(m.id)}" aria-haspopup="menu" aria-label="Manage access for ${esc(m.name)}" title="Change access or remove">⋯</button>` : ''}</div>`).join('')
        + (pending.length ? `<div class="mem-h">Invited, waiting to accept</div>${pending.map(i => `<div class="contrib mem"><span class="av mem-pend" style="--s:32px">…</span><div class="who"><b>@${esc(i.to?.username || '')}</b><span>${esc(i.to?.name || '')}</span></div>${chip(i.role)}<button class="outline-button btn-sm" data-cancel-inv="${esc(i.id)}">Cancel</button></div>`).join('')}` : '');
      $('#inviteMore')?.addEventListener('click', () => openInvite(pid));
      $$('[data-cancel-inv]', box).forEach(btn => btn.addEventListener('click', async () => { try { await api(`/invitations/${btn.dataset.cancelInv}`, { method: 'DELETE' }); notify('Invitation cancelled'); renderMembers(); } catch (error) { notify(error.message); } }));
      $$('[data-mm]', box).forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); const target = members.find(x => x.id === btn.dataset.mm); openMemberMenu(btn, target, pid); }));
    } catch (error) { box.textContent = error.message; }
  }
  // Per-person access menu: change what they can do, or remove them.
  function openMemberMenu(anchor, member, pid) {
    const open0 = document.querySelector('.mem-menu'); if (open0) { const same = open0._anchorId === member.id; open0._close(); if (same) return; } const r = anchor.getBoundingClientRect(); const menu = document.createElement('div'); menu.className = 'mem-menu'; menu.setAttribute('role', 'menu');
    const opt = (role, title, sub) => `<button role="menuitemradio" aria-checked="${member.role === role}" data-role="${role}"><span class="mm-ck">${member.role === role ? '✓' : ''}</span><span><b>${title}</b><small>${sub}</small></span></button>`;
    menu.innerHTML = `<div class="mm-who">${esc(member.name || '')} <span>@${esc(member.username || '')}</span></div>${opt('viewer', 'Can view', 'Read-only, can chat')}${opt('editor', 'Can edit', 'Change files and run code')}${opt('owner', 'Owner', 'Full control, can manage access')}<div class="mm-sep"></div><button role="menuitem" class="mm-danger" data-remove="1"><span class="mm-ck">✕</span><span><b>Remove from project</b><small>They lose access right away</small></span></button>`;
    document.body.appendChild(menu); const w = menu.offsetWidth, h = menu.offsetHeight; menu.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.right - w))}px`; menu.style.top = `${r.bottom + h + 12 > innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
    const close = () => { menu.remove(); document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onKey, true); };
    const onDoc = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) close(); }; const onKey = (e) => { if (e.key === 'Escape') close(); }; document.addEventListener('mousedown', onDoc, true); document.addEventListener('keydown', onKey, true); menu._close = close; menu._anchorId = member.id;
    $$('[data-role]', menu).forEach(b => b.addEventListener('click', async () => { close(); if (b.dataset.role === member.role) return; if (b.dataset.role === 'owner' && !await confirmBox('Make this person an owner?', 'Owners can invite and remove people and change settings, just like you.', { confirm: 'Make owner' })) return; try { await api(`/projects/${pid}/members/${member.id}`, { method: 'PATCH', body: JSON.stringify({ role: b.dataset.role }) }); notify(`${member.name} can now ${b.dataset.role === 'viewer' ? 'view only' : b.dataset.role === 'editor' ? 'edit' : 'manage this project as an owner'}`); } catch (error) { notify(error.message); } renderMembers(); }));
    $('[data-remove]', menu).addEventListener('click', async () => { close(); if (!await confirmBox(`Remove ${member.name}?`, 'They lose access to this project immediately. You can invite them again later.', { confirm: 'Remove', danger: true })) return; try { await api(`/projects/${pid}/members/${member.id}`, { method: 'DELETE' }); notify(`${member.name} was removed`); } catch (error) { notify(error.message); } renderMembers(); });
  }
  function openInvite(projectId) {
    let picked = null; let timer = null; const m = modal({ title: 'Invite people', sub: 'Search by username. They get a notification and can accept or decline.', width: 480,
      body: `<label class="hc-field">Username<input class="inp" id="invUser" autofocus autocomplete="off" placeholder="start typing a username or name"></label><div id="invResults" style="display:grid;gap:6px;margin-bottom:12px"></div><label class="hc-field">Role<select class="inp" id="invRole"><option value="editor">Editor: can change files</option><option value="viewer">Viewer: read-only</option><option value="owner">Owner: manage the project</option></select></label><div id="invMsg"></div><p class="muted small" style="margin:6px 0 0">You can change someone's access or remove them later from the <a href="#" id="invManage">People tab</a>.</p>`,
      actions: [{ label: 'Close' }, { label: 'Send invitation', kind: 'primary', keepOpen: true, id: 'send', onClick: async () => { const username = picked || m.$('#invUser').value.trim().replace(/^@/, ''); if (!username) { m.$('#invMsg').innerHTML = '<div class="notice bad">Enter a username first.</div>'; return false; } try { const r = await api(`/projects/${projectId}/invite-user`, { method: 'POST', body: JSON.stringify({ username, role: m.$('#invRole').value }) }); m.$('#invMsg').innerHTML = `<div class="notice ok">Invitation sent to @${esc(r.to.username)}.</div>`; m.$('#invUser').value = ''; picked = null; return false; } catch (error) { m.$('#invMsg').innerHTML = `<div class="notice bad">${esc(error.message)}</div>`; return false; } } }] });
    m.$('#invManage').addEventListener('click', (e) => { e.preventDefault(); m.close(); document.querySelector('.side-tabs [data-pane="people"]')?.click(); });
    m.$('#invUser').addEventListener('input', () => { picked = null; clearTimeout(timer); timer = setTimeout(async () => { const q = m.$('#invUser').value.trim().replace(/^@/, ''); if (q.length < 2) { m.$('#invResults').innerHTML = ''; return; } try { const { users } = await api(`/users/search?q=${encodeURIComponent(q)}`); m.$('#invResults').innerHTML = users.map(u => `<button type="button" class="person" data-u="${esc(u.username)}" style="cursor:pointer;text-align:left;color:inherit">${av(u, 30)}<span class="who"><b>${esc(u.name)}</b><span>@${esc(u.username)}</span></span></button>`).join('') || '<div class="muted small">No one found. Check the spelling, or send them an invite link.</div>'; $$('[data-u]', m.el).forEach(b => b.addEventListener('click', () => { picked = b.dataset.u; m.$('#invUser').value = `@${picked}`; m.$('#invResults').innerHTML = ''; })); } catch { /* ignore */ } }, 220); });
  }

  // ---------- assistant (right panel) ----------
  const threadKey = () => `hc-thread-${state.currentProject?.id || 'none'}`;
  const saveThread = () => { try { localStorage.setItem(threadKey(), JSON.stringify(state.thread.slice(-40))); } catch { /* storage full */ } };
  const mdHtml = (text) => (window.HCCollab?.renderMarkdown ? HCCollab.renderMarkdown(text) : `<p>${esc(text)}</p>`);
  const SUGGESTIONS = ['Explain what this project does', 'Find bugs in the open file', 'Write a README for this project', 'Add input validation to the open file'];
  function ensureAgentPanel() {
    const pane = $('#paneAssistant'); if (!pane) return; loadThread(); if ($('#assistThread')) { assistantRender(); return; }
    pane.innerHTML = `<div class="assist-head"><b>✦ Assistant</b><span class="grow"></span><span class="ib"><button id="assistHistory" title="Past chats" aria-label="Past chats" aria-haspopup="menu"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg></button><button id="assistNew" title="New conversation" aria-label="New conversation">＋</button></span></div>
      <div class="assist-thread" id="assistThread"></div><div id="proposalList"></div>
      <form class="assist-input" id="agentForm"><textarea id="agentPrompt" rows="2" placeholder="Ask about this project, or tell me what to change…" aria-label="Message the assistant"></textarea><div class="assist-actions"><div class="cbar"><button type="button" class="cchip" id="assistMode" title="Change the model" aria-haspopup="menu">…</button><button type="button" class="cchip" id="assistApprove" title="Choose what happens when the assistant edits files" aria-haspopup="menu">…</button><label class="cchip cctx" title="Include the file you have open when you send"><input type="checkbox" id="ctxFile" checked><span>File</span></label></div><button class="primary-button btn-sm" id="agentSend" aria-label="Send" title="Send (Enter)"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg></button></div></form><div id="agentResult" class="sr-only" aria-live="polite"></div>`;
    $('#agentForm').addEventListener('submit', runAgent); $('#agentPrompt').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#agentForm').requestSubmit(); } });
$('#assistMode').addEventListener('click', (e) => openModelMenu(e.currentTarget)); $('#assistApprove').addEventListener('click', (e) => openApproveMenu(e.currentTarget)); $('#agentPrompt').addEventListener('keydown', (e) => { if (e.key === 'Tab' && e.shiftKey && state.currentProject?.role === 'owner') { e.preventDefault(); setApproval(state.currentProject.agentApproval === 'auto' ? 'ask' : 'auto'); } }); refreshApproveChip(); $('#assistHistory').addEventListener('click', (e) => openHistoryMenu(e.currentTarget)); $('#assistNew').addEventListener('click', () => newChat());
    assistantRender();
  }
  function loadThread() { try { state.thread = JSON.parse(localStorage.getItem(threadKey()) || '[]'); } catch { state.thread = []; } }
  // ---- Past chats: "New conversation" files the current chat away; the clock button lists them and loads one back.
  const chatsKey = () => `hc-chats-${state.currentProject?.id || 'none'}`;
  const readChats = () => { try { const v = JSON.parse(localStorage.getItem(chatsKey()) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
  const writeChats = (list) => { try { localStorage.setItem(chatsKey(), JSON.stringify(list.slice(0, 30))); } catch { /* storage full */ } };
  const chatTitle = (thread) => { const first = thread.find(m => m.role === 'user')?.content || 'Conversation'; return first.replace(/\s+/g, ' ').trim().slice(0, 70); };
  function archiveCurrent() { if (!state.thread?.some(m => m.role === 'user')) return; writeChats([{ id: (crypto.randomUUID?.() || String(Date.now())), title: chatTitle(state.thread), at: Date.now(), messages: state.thread.slice(-40) }, ...readChats()]); }
  function newChat() { if (state.assistBusy) return; archiveCurrent(); state.thread = []; saveThread(); assistantRender(); }
  function loadChat(id) {
    if (state.assistBusy) { notify('Wait for the assistant to finish first'); return; } const list = readChats(); const chat = list.find(c => c.id === id); if (!chat) return;
    writeChats(list.filter(c => c.id !== id)); archiveCurrent(); state.thread = chat.messages; saveThread(); assistantRender(); notify('Opened an earlier chat');
  }
  function openHistoryMenu(anchor) {
    const open0 = document.querySelector('.hist-menu'); if (open0) { open0._close(); return; } if (!state.currentProject) { notify('Open a project to see its past chats'); return; }
    const menu = document.createElement('div'); menu.className = 'hist-menu'; menu.setAttribute('role', 'menu'); document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect(); menu.style.top = `${r.bottom + 6}px`; menu.style.right = `${Math.max(8, innerWidth - r.right - 6)}px`;
    const close = () => { menu.remove(); document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onKey, true); };
    const onDoc = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) close(); }; const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDoc, true); document.addEventListener('keydown', onKey, true); menu._close = close;
    const draw = () => { const list = readChats();
      menu.innerHTML = `<div class="hm-h"><b>Past chats</b><span>${list.length ? `${list.length} saved` : ''}</span></div>${list.length ? `<div class="hm-list">${list.map(c => `<div class="hm-row" role="menuitem" tabindex="0" data-id="${esc(c.id)}"><span class="hm-ic"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg></span><span class="hm-tx"><b>${esc(c.title)}</b><small>${esc(ago(c.at))} · ${c.messages.filter(m => m.role === 'user').length} message${c.messages.filter(m => m.role === 'user').length === 1 ? '' : 's'}</small></span><button class="hm-del" data-del="${esc(c.id)}" title="Delete this chat" aria-label="Delete this chat">✕</button></div>`).join('')}</div>` : '<div class="hm-empty"><b>No past chats yet</b><small>Press ＋ to start a new conversation. The current one is saved here so you can come back to it.</small></div>'}`;
      $$('.hm-row', menu).forEach(row => { const open = () => { close(); loadChat(row.dataset.id); }; row.addEventListener('click', (e) => { if (e.target.closest('[data-del]')) return; open(); }); row.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); }); });
      $$('[data-del]', menu).forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); writeChats(readChats().filter(c => c.id !== b.dataset.del)); draw(); }));
    }; draw();
  }
  function assistantRender() {
    const box = $('#assistThread'); if (!box) return;
    if (!state.thread.length) { box.innerHTML = `<div class="welcome"><h3>Hi ${esc((state.user?.name || 'there').split(' ')[0])}, I'm your coding assistant</h3><p>I can read this workspace, explain code, find bugs and propose edits. Changes always show a diff and wait for your approval.</p>${state.aiProvider === '' ? '<div class="demo-banner"><div><b>You are in demo mode</b><small>Connect your own Claude or ChatGPT account to get real answers.</small></div><button type="button" class="primary-button btn-sm" id="connectAi">Connect your AI</button></div>' : ''}<div class="sugg">${SUGGESTIONS.map(s => `<button type="button">${esc(s)}</button>`).join('')}</div></div>`; $$('.sugg button', box).forEach(b => b.addEventListener('click', () => { $('#agentPrompt').value = b.textContent; $('#agentForm').requestSubmit(); })); $('#connectAi', box)?.addEventListener('click', () => openConnectWizard()); return; }
    box.innerHTML = state.thread.map(bubbleHtml).join(''); box.scrollTop = box.scrollHeight;
  }
  const bubbleHtml = (m) => m.role === 'user' ? `<div class="bubble user">${esc(m.content)}</div>` : `<div class="bubble ai"><div class="who">✦ ${esc(m.provider || 'Assistant')}</div>${m.error ? `<div class="err">${esc(m.content)}</div>` : mdHtml(m.content)}${m.files?.length ? `<div class="files">${m.files.map(f => `<span class="chip mint">✓ ${esc(f)}</span>`).join('')}</div>` : ''}${m.pending ? `<div class="files"><span class="chip warn">${m.pending} change${m.pending === 1 ? '' : 's'} waiting for your approval below</span></div>` : ''}</div>`;
  // ---- Assistant composer bar: model + "what happens when it edits" menus (open upward, like the chat bar in code editors)
  function barMenu(anchor, { title, hint = '', items, footer = null }) {
    const open0 = document.querySelector('.bar-menu'); if (open0) { const same = open0._anchor === anchor; open0._close(); if (same) return; } const r = anchor.getBoundingClientRect(); const menu = document.createElement('div'); menu.className = 'bar-menu'; menu.setAttribute('role', 'menu');
    menu.innerHTML = `<div class="bm-h"><b>${esc(title)}</b>${hint ? `<span>${hint}</span>` : ''}</div><div class="bm-list">${items.map((it, i) => `${it.group ? `<div class="bm-g">${esc(it.group)}</div>` : ''}<button role="menuitemradio" aria-checked="${Boolean(it.checked)}" class="bm-item ${it.checked ? 'on' : ''}" data-i="${i}" ${it.disabled ? 'disabled' : ''}><span class="bm-ic">${it.icon || ''}</span><span class="bm-tx"><b>${esc(it.title)}</b><small>${esc(it.sub || '')}</small></span>${it.checked ? '<span class="bm-ck">✓</span>' : ''}</button>`).join('')}</div>${footer ? `<button class="bm-foot" id="bmFoot">${footer.icon || ''}<span>${esc(footer.title)}</span></button>` : ''}`;
    document.body.appendChild(menu); const w = menu.offsetWidth; menu.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left))}px`; menu.style.bottom = `${innerHeight - r.top + 8}px`; menu.style.maxHeight = `${r.top - 16}px`;
    const close = () => { menu.remove(); document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onKey, true); };
    const onDoc = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) close(); }; const onKey = (e) => { if (e.key === 'Escape') close(); }; document.addEventListener('mousedown', onDoc, true); document.addEventListener('keydown', onKey, true); menu._close = close; menu._anchor = anchor;
    $$('.bm-item', menu).forEach(b => b.addEventListener('click', () => { close(); items[Number(b.dataset.i)].onClick?.(); })); $('#bmFoot', menu)?.addEventListener('click', () => { close(); footer.onClick(); });
  }
  const BI = (d) => `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  function refreshApproveChip() {
    const b = $('#assistApprove'); if (!b) return; const auto = state.currentProject?.agentApproval === 'auto'; const owner = state.currentProject?.role === 'owner';
    b.innerHTML = `${auto ? BI('<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>') : BI('<path d="M9 11V5a1.5 1.5 0 0 1 3 0v5M12 10V4a1.5 1.5 0 0 1 3 0v7M15 10.5V6.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1a6 6 0 0 1-5-3l-2-3.5a1.5 1.5 0 0 1 2.5-1.5L9 15V8a1.5 1.5 0 0 1 3 0"/>')}<span>${auto ? 'Auto-apply' : 'Ask first'}</span>`;
    b.classList.toggle('auto', auto); b.disabled = !state.currentProject; b.title = owner ? 'Choose what happens when the assistant edits files (Shift+Tab to switch)' : 'Only the project owner can change this';
  }
  async function setApproval(mode) {
    if (!state.currentProject) return; if (state.currentProject.role !== 'owner') { notify('Only the project owner can change this'); return; }
    try { const a = await api(`/projects/${state.currentProject.id}`, { method: 'PATCH', body: JSON.stringify({ agentApproval: mode }) }); state.currentProject.agentApproval = a.agentApproval; refreshApproveChip(); notify(a.agentApproval === 'auto' ? 'Assistant edits are applied automatically' : 'Assistant edits wait for your approval'); } catch (error) { notify(error.message); }
  }
  function openApproveMenu(anchor) {
    const auto = state.currentProject?.agentApproval === 'auto'; const owner = state.currentProject?.role === 'owner';
    barMenu(anchor, { title: 'When the assistant edits files', hint: owner ? '<kbd>⇧</kbd> + <kbd>Tab</kbd> to switch' : 'Owner only', items: [
      { icon: BI('<path d="M9 11V5a1.5 1.5 0 0 1 3 0v5M12 10V4a1.5 1.5 0 0 1 3 0v7M15 10.5V6.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1a6 6 0 0 1-5-3l-2-3.5a1.5 1.5 0 0 1 2.5-1.5L9 15V8a1.5 1.5 0 0 1 3 0"/>'), title: 'Ask first', sub: 'Changes show as a diff and wait for your approval (recommended)', checked: !auto, disabled: !owner, onClick: () => setApproval('ask') },
      { icon: BI('<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>'), title: 'Auto-apply', sub: 'Changes are written to the files right away, everyone sees them live', checked: auto, disabled: !owner, onClick: () => setApproval('auto') }] });
  }
  function openModelMenu(anchor) {
    const ai = state.aiInfo; if (!ai) { notify('Loading…'); return; } const cur = ai.provider || 'demo';
    const set = async (provider, preset) => { try { await api('/me/ai', { method: 'PUT', body: JSON.stringify({ provider: provider === 'demo' ? '' : provider }) }); state.aiProvider = provider === 'demo' ? '' : provider; notify(`Assistant: ${preset.label.split(' (')[0].replace(': sign in', '')}`); refreshAssistMode(); assistantRender(); } catch (error) { notify(error.message); openAssistantSettings(provider); } };
    const pick = async (preset) => {
      if (preset.id === cur) return;
      if (preset.local) { let st = null; try { st = await bridgeCall('/status', null, 2500); } catch { st = null; } const t = st?.tools?.[preset.local]; if (t?.installed && t.signedIn !== false) return set(preset.id, preset); return openConnectWizard(preset.local); }
      if (preset.id === 'demo' || preset.id === 'ollama') return set(preset.id, preset);
      openAssistantSettings(preset.id);
    };
    const sub = (p) => p.local ? 'Sign in with your own account' : p.id === 'demo' ? 'No AI, just try the interface' : p.id === 'ollama' ? 'Free, runs on your computer' : p.needsKey ? 'Needs your API key' : 'Your own server';
    const order = [['Sign in with your account', ai.presets.filter(p => p.local)], ['Free', ai.presets.filter(p => ['demo', 'ollama'].includes(p.id))], ['Bring your own key', ai.presets.filter(p => !p.local && !['demo', 'ollama'].includes(p.id))]];
    const items = order.flatMap(([group, list]) => list.map((p, i) => ({ group: i === 0 ? group : '', icon: p.local ? BI('<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>') : p.id === 'demo' ? BI('<rect x="4" y="5" width="16" height="12" rx="2"/><path d="M8 21h8"/>') : BI('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>'), title: p.label.split(' (')[0].replace(': sign in', ''), sub: sub(p), checked: p.id === cur, onClick: () => pick(p) })));
    barMenu(anchor, { title: 'Model', items, footer: { icon: BI('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'), title: 'Model name, API key and more…', onClick: () => openAssistantSettings() } });
  }
  // Simple 3-step "connect your AI" guide (download launcher, open it, sign in). Saves the choice by itself when ready.
  function openConnectWizard(initial = 'claude') {
    let tool = initial === 'codex' ? 'codex' : 'claude'; let timer = null; let finished = false;
    const m = modal({ title: 'Connect your AI', sub: 'Use your own Claude or ChatGPT account in the assistant. It takes about a minute, and no password is typed into HackConnect.', width: 520, onClose: () => clearInterval(timer),
      body: '<div class="wz-pick" id="wzPick"></div><div id="wzSteps"></div>', actions: [{ label: 'Close' }] });
    const names = { claude: ['Claude', 'Claude Code'], codex: ['Codex', 'Codex CLI'] };
    const draw = async () => {
      if (!m.el.isConnected || finished) return clearInterval(timer); const [name, cli] = names[tool];
      $('#wzPick', m.el).innerHTML = ['claude', 'codex'].map(k => `<button type="button" class="wz-card ${k === tool ? 'on' : ''}" data-t="${k}"><b>${k === 'claude' ? 'Claude' : 'ChatGPT / Codex'}</b><small>${k === 'claude' ? 'Anthropic account' : 'OpenAI account'}</small></button>`).join('');
      $$('.wz-card', m.el).forEach(b => b.addEventListener('click', () => { tool = b.dataset.t; draw(); }));
      let st = null; try { st = await bridgeCall('/status', null, 3000); } catch { st = null; } const t = st?.tools?.[tool]; const up = Boolean(st); const have = Boolean(t?.installed); const signed = have && t.signedIn === true; const ready = have && t.signedIn !== false && st;
      const row = (n, done, active, title, body) => `<div class="wz-step ${done ? 'done' : active ? 'now' : ''}"><span class="wz-n">${done ? '✓' : n}</span><div class="wz-b"><b>${title}</b>${body}</div></div>`;
      $('#wzSteps', m.el).innerHTML =
        row(1, up, !up, 'Download the launcher', up ? '<small>Done</small>' : `<small>A small file with a start button. It only needs Node.js (free).</small><a class="primary-button wz-btn" href="/download/hackconnect-assistant.zip?tool=${tool}" download>⬇ Download launcher</a>`) +
        row(2, up, false, 'Open it', up ? '<small>Launcher is running on this computer</small>' : '<small>Unzip the file and double-click <b>start-assistant</b>. A black window opens: keep it open. If it offers to install ' + cli + ', press <b>Y</b>.</small><small class="wz-wait">Waiting for the launcher…</small>') +
        row(3, signed, up, `Sign in with ${name}`, !up ? '<small>Unlocks after step 2</small>' : !have ? `<small>${cli} is not installed yet. Run the launcher again and press <b>Y</b> to install it, or run <code>npm install -g ${tool === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex'}</code>.</small>` : signed ? '<small>Signed in</small>' : `<small>A ${name} sign-in page opens on your computer. Finish there and this updates by itself.</small><button class="primary-button wz-btn" id="wzSign" type="button">Sign in with ${name}</button>${t.signedIn === null ? '<button class="outline-button wz-btn" id="wzDone" type="button">I am already signed in</button>' : ''}`);
      $('#wzSign', m.el)?.addEventListener('click', async () => { try { const r = await bridgeCall('/login', { tool }, 8000); notify(r.started ? `Opening the ${name} sign-in page…` : (r.error || 'Could not start sign-in')); } catch (error) { notify(error.message); } });
      const finish = async () => { finished = true; clearInterval(timer); try { await api('/me/ai', { method: 'PUT', body: JSON.stringify({ provider: `local-${tool}` }) }); state.aiProvider = `local-${tool}`; notify(`${name} connected. Ask the assistant anything.`); refreshAssistMode(); assistantRender(); m.close(); } catch (error) { finished = false; notify(error.message); } };
      $('#wzDone', m.el)?.addEventListener('click', finish); if (signed) finish();
    };
    draw(); timer = setInterval(draw, 2500);
  }
  // ---- "Sign in" providers: the answer comes from Claude Code / Codex running on the user's own computer through the assistant bridge.
  const BRIDGE = 'http://127.0.0.1:47831';
  async function bridgeCall(path, body, timeout = 200000) {
    let res; try { res = await fetch(`${BRIDGE}${path}`, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) }); } catch (error) { const e = new Error('Cannot reach the assistant bridge on your computer. Open the assistant settings (gear icon) to set it up.'); e.code = 'bridge-down'; throw e; }
    return res.json();
  }
  async function askAssistant(prompt, history, focus) {
    const id = state.currentProject.id; if (state.aiProvider === undefined) { try { state.aiProvider = (await api('/me/ai')).provider || ''; } catch { state.aiProvider = ''; } }
    if (!String(state.aiProvider).startsWith('local-')) return api(`/projects/${id}/agent`, { method: 'POST', body: JSON.stringify({ prompt, history, focus }) });
    const tool = state.aiProvider.slice(6);
    const prep = await api(`/projects/${id}/agent`, { method: 'POST', body: JSON.stringify({ prompt, history, focus, prepare: true }) });
    const run = await bridgeCall('/run', { tool, prompt: prep.prompt }); if (!run.ok) throw new Error(run.error || 'The assistant bridge could not answer.');
    return api(`/projects/${id}/agent`, { method: 'POST', body: JSON.stringify({ prompt, history, focus, localText: run.text, localTool: tool }) });
  }
  async function renderLocalCard(m, tool) {
    const box = m.$('#aiLocal'); const name = tool === 'claude' ? 'Claude' : 'Codex'; const cli = tool === 'claude' ? 'Claude Code' : 'Codex CLI'; const install = tool === 'claude' ? 'npm install -g @anthropic-ai/claude-code' : 'npm install -g @openai/codex'; const cmd = `hackconnect assistant --origin ${location.origin}`;
    let timer = null; const stop = () => { clearInterval(timer); timer = null; };
    const step = (state, title, sub) => `<div class="loc-step ${state}"><span class="loc-dot">${state === 'ok' ? '✓' : state === 'bad' ? '!' : '…'}</span><div><b>${title}</b><small>${sub}</small></div></div>`;
    const draw = async () => {
      if (!box.isConnected || box.hidden) return stop(); let st = null; try { st = await bridgeCall('/status', null, 4000); } catch { st = null; }
      const t = st?.tools?.[tool]; const ready = Boolean(t?.installed && t.signedIn !== false);
      box.innerHTML = `<div class="loc">${step(st ? 'ok' : 'bad', 'Assistant bridge', st ? 'Running on this computer' : 'Not running. Start it with the steps below.')}${step(!st ? 'wait' : !t.installed ? 'bad' : t.signedIn === false ? 'bad' : 'ok', `${cli}`, !st ? 'Waiting for the bridge' : !t.installed ? `Not installed. Install it with <code>${esc(install)}</code>` : t.signedIn === false ? `Installed${t.version ? ' (' + esc(t.version) + ')' : ''}, not signed in yet` : t.signedIn === null ? `Installed${t.version ? ' (' + esc(t.version) + ')' : ''}. Sign in if it asks you to.` : `Signed in${t.version ? ' · ' + esc(t.version) : ''}`)}
        <div class="btn-row loc-act"><button class="primary-button" id="locSign" ${st && t?.installed ? '' : 'disabled'}>${ready && t.signedIn ? `Switch ${name} account` : `Sign in with ${name}`}</button><button class="outline-button" id="locCheck">Re-check</button></div>
        ${st ? '' : `<div class="loc-easy"><a class="primary-button" href="/download/hackconnect-assistant.zip?tool=${tool}" download>⬇ Download the ${name} launcher</a><small>Unzip it and double-click <b>start-assistant</b>. Keep that window open, then press Re-check. Needs Node.js (free).</small></div>`}
        <p class="muted small loc-note">Your ${name} password and keys never reach HackConnect. You sign in with the ${cli} tool (it opens its own sign-in page on your computer) and the questions you ask here are answered by that tool, using your ${name} plan.</p></div>`;
      $('#locCheck', box)?.addEventListener('click', draw); $('#locCopy', box)?.addEventListener('click', () => copyText(cmd));
      $('#locSign', box)?.addEventListener('click', async () => { try { const r = await bridgeCall('/login', { tool }, 8000); if (r.started) { notify(`A sign-in page should open on your computer. ${r.hint || ''} Finish there, then this updates by itself.`); stop(); let n = 0; timer = setInterval(() => { if (++n > 40) stop(); else draw(); }, 3000); } else notify(r.error || 'Could not start sign-in'); } catch (error) { notify(error.message); } });
    };
    await draw();
  }
  async function runAgent(event) {
    event.preventDefault(); if (state.assistBusy) return; const input = $('#agentPrompt'); const prompt = input.value.trim(); if (!prompt || !state.currentProject) return;
    const history = state.thread.filter(m => !m.error).slice(-8).map(m => ({ role: m.role, content: m.content })); state.thread.push({ role: 'user', content: prompt }); input.value = ''; state.assistBusy = true; $('#agentSend').disabled = true; assistantRender();
    const box = $('#assistThread'); box.insertAdjacentHTML('beforeend', '<div class="bubble ai" id="typing"><div class="who">✦ Thinking…</div><span class="typing"><i></i><i></i><i></i></span></div>'); box.scrollTop = box.scrollHeight;
    try {
      const focus = $('#ctxFile')?.checked ? state.activePath : null; const result = await askAssistant(prompt, history, focus);
      state.thread.push({ role: 'assistant', content: result.message, provider: result.provider, files: (result.changes || []).map(c => c.path), pending: result.proposals?.length || 0 }); (result.changes || []).forEach(c => { state.currentProject.files[c.path] = c.content; });
      if (result.proposals?.length) loadProposals();
    } catch (error) { state.thread.push({ role: 'assistant', content: error.message, error: true }); }
    finally { state.assistBusy = false; $('#agentSend').disabled = false; saveThread(); assistantRender(); $('#agentPrompt')?.focus(); }
  }
  function showAgentResult(message, count, pending = 0) { if (state.assistBusy) return; const box = $('#agentResult'); if (box) box.textContent = `${message} ${count ? `${count} file(s) updated.` : ''}`; if (pending) loadProposals(); }
  async function loadProposals() {
    const holder = $('#proposalList'); if (!holder || !state.currentProject) return;
    try { const { proposals } = await api(`/projects/${state.currentProject.id}/proposals`); const canApply = canWrite();
      holder.innerHTML = proposals.map(p => `<div class="proposal" data-id="${esc(p.id)}"><b>${esc(p.actor)}</b> wants to change <code>${esc(p.path)}</code><pre>${p.diff.filter(d => d.t !== ' ').slice(0, 80).map(d => `<span style="color:${d.t === '+' ? 'var(--mint)' : '#ff9b9b'}">${d.t} ${esc(d.s)}</span>`).join('\n') || 'No visible change'}</pre>${canApply ? '<div class="btn-row"><button class="primary-button btn-sm" data-act="approve">Apply</button><button class="outline-button btn-sm" data-act="reject">Dismiss</button></div>' : '<small class="muted">Only editors can apply changes.</small>'}</div>`).join('');
      $$('.proposal button', holder).forEach(button => button.addEventListener('click', async () => { try { await api(`/projects/${state.currentProject.id}/proposals/${button.closest('.proposal').dataset.id}/${button.dataset.act}`, { method: 'POST', body: '{}' }); notify(button.dataset.act === 'approve' ? 'Change applied' : 'Change dismissed'); } catch (error) { notify(error.message); } loadProposals(); }));
    } catch { /* viewers or offline */ }
  }
  async function refreshAssistMode() { refreshApproveChip(); const chip = $('#assistMode'); if (!chip) return; try { const ai = await api('/me/ai'); state.aiProvider = ai.provider || ''; const preset = ai.presets.find(p => p.id === ai.provider); chip.textContent = ai.provider && ai.provider !== 'demo' ? (preset?.local ? (preset.local === 'claude' ? 'Claude' : 'Codex') : (preset?.label.split(' (')[0] || ai.provider)) + (ai.model ? ` · ${ai.model}` : '') : (ai.serverDefault && ai.serverDefault !== 'demo' ? `server: ${ai.serverDefault}` : 'demo mode'); chip.className = `cchip cmodel ${ai.provider && ai.provider !== 'demo' ? 'live' : 'demo'}`; state.aiInfo = ai; chip.title = 'Change the model'; refreshApproveChip(); if (!state.thread?.length) assistantRender(); } catch { chip.textContent = 'offline'; } }
  const HINTS = { ollama: 'Free and private. Install Ollama from ollama.com, run <code>ollama pull qwen2.5-coder</code>, then keep it running. Works when HackConnect runs on your own computer.', groq: 'Free tier. Create a key at console.groq.com/keys.', gemini: 'Free tier. Create a key at aistudio.google.com/apikey.', openrouter: 'Has free models (names ending in :free). Create a key at openrouter.ai/keys.', openai: 'Paid. Key from platform.openai.com/api-keys.', anthropic: 'Paid. Key from console.anthropic.com. Uses the Claude models.', custom: 'Any server that speaks the OpenAI chat API (LM Studio, vLLM, llama.cpp…).', demo: 'No AI is called. Good for trying the interface.', 'local-claude': 'Use your own Claude account. Nothing is typed into HackConnect: you sign in with the Claude Code tool on your computer.', 'local-codex': 'Use your own ChatGPT / OpenAI account through the Codex tool on your computer. Nothing is typed into HackConnect.' };
  async function openAssistantSettings(pre = '') {
    let ai; try { ai = await api('/me/ai'); } catch (error) { return notify(error.message); }
    const ownerOfProject = state.currentProject?.role === 'owner';
    const m = modal({ title: 'Assistant settings', sub: 'Bring your own model. Your API key is encrypted on the server and never shown again.', width: 540,
      body: `<label class="hc-field">Provider<select class="inp" id="aiProv">${ai.presets.map(p => `<option value="${p.id}" ${(ai.provider || 'demo') === p.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select><small id="aiHint"></small></label>
        <div id="aiLocal" hidden></div><div id="aiFields"><label class="hc-field">Model<input class="inp" id="aiModel" value="${esc(ai.model)}" placeholder="model name"></label><label class="hc-field" id="aiUrlRow">Server address<input class="inp" id="aiUrl" value="${esc(ai.baseUrl)}" placeholder="http://localhost:11434/v1"></label><label class="hc-field" id="aiKeyRow">API key<input class="inp" id="aiKey" type="password" autocomplete="off" placeholder="${ai.hasKey ? '•••••••• saved (leave empty to keep)' : 'paste your key'}"></label></div>
        <div id="aiMsg"></div>`,
      actions: [{ label: 'Remove my settings', kind: 'danger', keepOpen: true, onClick: async () => { await api('/me/ai', { method: 'DELETE' }); notify('Assistant settings removed'); refreshAssistMode(); return true; } }, { label: 'Cancel' }, { label: 'Save', kind: 'primary', keepOpen: true, onClick: async () => { try { const provider = m.$('#aiProv').value; await api('/me/ai', { method: 'PUT', body: JSON.stringify({ provider: provider === 'demo' ? '' : provider, model: m.$('#aiModel').value.trim(), baseUrl: m.$('#aiUrl').value.trim(), apiKey: m.$('#aiKey').value }) }); notify('Assistant settings saved'); refreshAssistMode(); m.close(); return true; } catch (error) { m.$('#aiMsg').innerHTML = `<div class="notice bad">${esc(error.message)}</div>`; return false; } } }] });
    const sync = (fromUser) => { const id = m.$('#aiProv').value; const preset = ai.presets.find(p => p.id === id) || {}; m.$('#aiHint').innerHTML = HINTS[id] || ''; m.$('#aiFields').style.display = id === 'demo' || preset.local ? 'none' : ''; m.$('#aiLocal').hidden = !preset.local; if (preset.local) renderLocalCard(m, preset.local); m.$('#aiUrlRow').style.display = ['anthropic', 'demo'].includes(id) ? 'none' : ''; m.$('#aiKeyRow').style.display = preset.needsKey === false && id !== 'custom' ? 'none' : ''; if (fromUser) { m.$('#aiModel').value = preset.model || ''; m.$('#aiUrl').value = preset.baseUrl || ''; } m.$('#aiModel').placeholder = preset.model || 'model name'; };
    m.$('#aiProv').addEventListener('change', () => sync(true)); sync(false); if (pre && ai.presets.some(x => x.id === pre)) { m.$('#aiProv').value = pre; sync(true); }
  }
  async function openConnectAgent() {
    if (!state.currentProject) return; const owner = state.currentProject.role === 'owner';
    const m = modal({ title: 'Connect an external agent', sub: 'Let Claude Code, Codex or Cursor read and edit this workspace live, from their own terminal. Their changes appear for everyone, labelled as agent edits.', width: 620,
      body: owner ? `<div class="btn-row" style="margin-bottom:12px"><label class="hc-field" style="margin:0;flex:1">Name<input class="inp" id="agName" value="Claude Code"></label><label class="hc-field" style="margin:0">Access<select class="inp" id="agRole"><option value="editor">Can edit</option><option value="viewer">Read-only</option></select></label></div><button class="primary-button" id="agMake">Create access token</button><div id="agOut" style="margin-top:14px"></div>` : '<div class="notice">Only the project owner can create agent access tokens.</div>', actions: [{ label: 'Close' }] });
    $('#agMake', m.el)?.addEventListener('click', async () => { try { const t = await api(`/projects/${state.currentProject.id}/tokens`, { method: 'POST', body: JSON.stringify({ role: m.$('#agRole').value, label: m.$('#agName').value.trim() || 'Agent' }) }); const url = `${location.origin}/mcp`; const cmds = {
        'Claude Code': `claude mcp add --transport http hackconnect ${url} --header "Authorization: Bearer ${t.token}"`,
        Cursor: `{\n  "mcpServers": {\n    "hackconnect": {\n      "url": "${url}",\n      "headers": { "Authorization": "Bearer ${t.token}" }\n    }\n  }\n}\n\n# save as .cursor/mcp.json in your project`,
        'Codex / other MCP clients': `Server type: Streamable HTTP\nURL: ${url}\nHeader: Authorization: Bearer ${t.token}\n\nTools: list_files, read_file, write_file, replace_in_file` };
      m.$('#agOut').innerHTML = `<div class="notice ok" style="margin-bottom:12px">Token created. It is shown only now, so copy the command you need.</div><div class="hc-tabs" style="margin-top:0">${Object.keys(cmds).map((k, i) => `<button data-t="${esc(k)}" class="${i ? '' : 'on'}">${esc(k)}</button>`).join('')}</div><div class="codebox" id="agCode"><button class="outline-button btn-sm" id="agCopy">Copy</button><span id="agText"></span></div>${state.currentProject.agentApproval !== 'auto' ? '<p class="muted small">Edits from agents wait for your approval in the Assistant panel (change this under ⚙).</p>' : ''}`;
      const show = (k) => { m.$('#agText').textContent = cmds[k]; $$('.hc-tabs button', m.el).forEach(b => b.classList.toggle('on', b.dataset.t === k)); }; show('Claude Code'); $$('.hc-tabs button', m.el).forEach(b => b.addEventListener('click', () => show(b.dataset.t))); m.$('#agCopy').addEventListener('click', () => copyText(m.$('#agText').textContent)); } catch (error) { m.$('#agOut').innerHTML = `<div class="notice bad">${esc(error.message)}</div>`; } });
  }
  async function toggleApproval() { openAssistantSettings(); }
  const connectExternalAgent = openConnectAgent;

  // ---------- extensions panel ----------
  function openExtensions() {
    const s = state.settings; const themes = window.HCCollab?.THEME_NAMES || [['hackconnect', 'HackConnect Dark']];
    const toggle = (id, title, desc, icon, on) => `<div class="ext"><span class="ico">${icon}</span><span class="info"><b>${title}</b><span>${desc}</span></span><label class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} aria-label="${title}"><i></i></label></div>`;
    const m = modal({ title: 'Extensions & editor', sub: 'Turn editor features on or off. Changes apply instantly and are remembered on this device.', width: 640,
      body: `<div class="hc-tabs"><button class="on" data-tab="ext">Installed</button><button data-tab="get">Get more</button></div>
        <div data-pane="ext"><div class="ext"><span class="ico">◐</span><span class="info"><b>Color theme</b><span>Syntax colors for the editor</span></span><select class="inp" id="xTheme" style="width:auto">${themes.map(([id, label]) => `<option value="${id}" ${s.theme === id ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></div>
          <div class="ext"><span class="ico">Aa</span><span class="info"><b>Font size</b><span>Editor text size in pixels</span></span><input class="inp" id="xFont" type="number" min="10" max="28" value="${s.fontSize}" style="width:84px"></div>
          <div class="ext"><span class="ico">⇥</span><span class="info"><b>Tab size</b><span>Spaces per indent level</span></span><select class="inp" id="xTab" style="width:auto">${[2, 4, 8].map(n => `<option ${s.tabSize === n ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
          ${toggle('xFormat', 'Format on save', 'Press Ctrl+S to tidy JavaScript, TypeScript, JSON, CSS and HTML', '✨', s.formatOnSave)}${toggle('xMini', 'Minimap', 'A zoomed-out overview of the file on the right', '▤', s.minimap)}${toggle('xWrap', 'Word wrap', 'Wrap long lines instead of scrolling sideways', '↩', s.wordWrap)}${toggle('xBrackets', 'Bracket pair colors', 'Color matching brackets so nesting is easy to read', '()', s.brackets)}${toggle('xLig', 'Font ligatures', 'Combine characters like => and !== (needs a ligature font)', '≠', s.ligatures)}${toggle('xCaret', 'Smooth caret', 'Animate the cursor as it moves', '▍', s.smoothCaret)}${toggle('xWs', 'Show whitespace', 'Make spaces and tabs visible', '·', s.whitespace)}</div>
        <div data-pane="get" hidden><div class="ext"><span class="ico">⬇</span><span class="info"><b>HackConnect for VS Code</b><span>Share the folder open in VS Code (or Cursor) with this workspace. Install via Extensions panel › ⋯ › Install from VSIX.</span></span><a class="primary-button btn-sm" href="/download/hackconnect-vscode.vsix" download style="text-decoration:none">Download .vsix</a></div>
          <div class="ext"><span class="ico">⌁</span><span class="info"><b>Local Bridge (command line)</b><span>Two-way sync for any folder, plus <code>expose</code> to share a running app. Needs Node.js 20+.</span></span><a class="outline-button btn-sm" href="/download/hackconnect-bridge.zip" download style="text-decoration:none">Download .zip</a></div>
          <div class="ext"><span class="ico">✦</span><span class="info"><b>Claude Code, Codex, Cursor</b><span>Connect your own coding agent over MCP with a scoped, revocable token.</span></span><button class="outline-button btn-sm" id="xAgent">Connect</button></div>
          <div class="ext"><span class="ico">◈</span><span class="info"><b>Bring your own model</b><span>Use Ollama (free, local), Groq or Gemini (free tiers), OpenRouter, OpenAI or Claude in the Assistant.</span></span><button class="outline-button btn-sm" id="xModel">Set up</button></div>
          <div class="notice" style="margin-top:14px">VS Code Marketplace extensions can't run inside the browser editor (they need VS Code itself). Use the extension above to bring HackConnect <i>into</i> your desktop editor.</div></div>`, actions: [{ label: 'Done', kind: 'primary' }] });
    $$('.hc-tabs button', m.el).forEach(b => b.addEventListener('click', () => { $$('.hc-tabs button', m.el).forEach(x => x.classList.toggle('on', x === b)); $$('[data-pane]', m.el).forEach(p => { p.hidden = p.dataset.pane !== b.dataset.tab; }); }));
    const on = (id, key, read = (el) => el.checked) => m.$(id).addEventListener('change', e => saveSettings({ [key]: read(e.target) }));
    on('#xTheme', 'theme', el => el.value); on('#xFont', 'fontSize', el => Math.min(28, Math.max(10, Number(el.value) || 13))); on('#xTab', 'tabSize', el => Number(el.value)); on('#xFormat', 'formatOnSave'); on('#xMini', 'minimap'); on('#xWrap', 'wordWrap'); on('#xBrackets', 'brackets'); on('#xLig', 'ligatures'); on('#xCaret', 'smoothCaret'); on('#xWs', 'whitespace');
    m.$('#xAgent').addEventListener('click', () => { m.close(); openConnectAgent(); }); m.$('#xModel').addEventListener('click', () => { m.close(); openAssistantSettings(); });
  }

  // ---------- command palette (Ctrl/Cmd + K) ----------
  function openPalette() {
    if ($('.palette')) return; const files = Object.keys(state.currentProject?.files || {}).sort(); const acts = [['New file', () => createFile('')], ['New folder', () => createFolder('')], ['Import files…', () => state.currentProject && window.HC.openImport?.(state.currentProject.id)], ['Invite people…', () => state.currentProject && openInvite(state.currentProject.id)], ['Open project page', () => state.currentProject && window.HC.openProjectPage?.(state.currentProject.id)], ['Assistant settings', openAssistantSettings], ['Connect Claude Code / Codex / Cursor', openConnectAgent], ['Extensions & editor settings', openExtensions], ['Focus the assistant', () => { showPane('assistant'); }], ['Open chat', () => showPane('chat')], ['Show people', () => showPane('people')], ['Format document', () => state.editor && window.HCCollab?.formatDocument(state.editor)], ['Start a call', () => startCall()], ...(window.HCCollab?.THEME_NAMES || []).map(([id, label]) => [`Theme: ${label}`, () => saveSettings({ theme: id })])];
    const items = [...files.map(f => ({ label: f, hint: 'file', run: () => { state.following = null; selectFile(f); } })), ...acts.map(([label, run]) => ({ label, hint: 'command', run }))];
    const m = modal({ width: 560, body: '<input id="palIn" class="inp" style="border:0;border-bottom:1px solid var(--line);border-radius:0;font-size:15px;padding:14px 16px" placeholder="Type a file name or a command…" autofocus aria-label="Command palette"><ul id="palList" style="list-style:none;margin:0;padding:6px;max-height:340px;overflow:auto" role="listbox"></ul>' }); m.el.querySelector('.hc-card').classList.add('palette'); m.el.querySelector('.hc-card').style.cssText += ';padding:0;align-self:start;margin-top:12vh'; let sel = 0; let shown = [];
    const draw = () => { const q = m.$('#palIn').value.toLowerCase().trim(); shown = items.filter(i => !q || i.label.toLowerCase().includes(q)).slice(0, 40); sel = Math.min(sel, Math.max(0, shown.length - 1)); m.$('#palList').innerHTML = shown.map((i, n) => `<li class="${n === sel ? 'on' : ''}" role="option" data-n="${n}" style="display:flex;justify-content:space-between;gap:12px;padding:9px 12px;border-radius:8px;cursor:pointer;font-size:13px;${n === sel ? 'background:rgba(185,240,124,.14);color:var(--text)' : 'color:var(--soft)'}"><span>${esc(i.label)}</span><small style="color:var(--muted)">${i.hint}</small></li>`).join('') || '<li class="muted" style="padding:12px">Nothing matches</li>'; $$('#palList li[data-n]', m.el).forEach(li => li.addEventListener('click', () => run(Number(li.dataset.n)))); m.$('#palList .on')?.scrollIntoView({ block: 'nearest' }); };
    const run = (n) => { const item = shown[n]; if (!item) return; m.close(); setTimeout(() => item.run(), 30); };
    m.$('#palIn').addEventListener('input', () => { sel = 0; draw(); }); m.$('#palIn').addEventListener('keydown', e => { if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); draw(); } else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); } else if (e.key === 'Enter') { e.preventDefault(); run(sel); } }); draw();
  }
  document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && state.user) { e.preventDefault(); openPalette(); } });

  buildIde();

  function projectIcon(project, index) { return `<div class="project-icon ${index % 3 === 1 ? 'purple' : index % 3 === 2 ? 'yellow' : ''}">${esc(project.name.slice(0, 1).toUpperCase())}</div>`; }
  function renderProjects() {
    const markup = state.projects.map((project, index) => `<div class="project" data-project-id="${esc(project.id)}" data-project="${esc(project.name)}">${projectIcon(project, index)}<div><div class="project-title">${esc(project.name)}</div><div class="project-description">${esc(project.description)}</div></div><div class="people"><div class="avatar">AK</div><div class="avatar orange">MS</div><div class="avatar blue">+2</div></div><div class="project-time"><span class="status">Live now</span><br><span style="color:var(--muted)">Synced</span></div></div>`).join('');
    window.dispatchEvent(new CustomEvent('hc:projects', { detail: state.projects }));
    const recent = $('#projectList'); if (recent) recent.innerHTML = markup.slice(0, 3 * 0) || state.projects.slice(0, 3).map((project, index) => `<div class="project" data-project-id="${esc(project.id)}" data-project="${esc(project.name)}">${projectIcon(project, index)}<div><div class="project-title">${esc(project.name)}</div><div class="project-description">${esc(project.description)}</div></div><div class="people"><div class="avatar">AK</div><div class="avatar orange">MS</div><div class="avatar blue">+2</div></div><div class="project-time"><span class="status">Live now</span><br><span style="color:var(--muted)">Synced</span></div></div>`).join('');
    $$('.project[data-project-id]').forEach(row => row.addEventListener('click', () => (window.HC.openProjectPage ? window.HC.openProjectPage(row.dataset.projectId) : openProject(row.dataset.projectId))));
  }

  async function loadBootstrap() { try { const data = await api('/bootstrap'); state.user = data.user; state.projects = data.projects || []; state.activity = data.activity || []; applyUser(); showVerifyBanner(); renderProjects(); } catch (error) { if (!state.user) return; notify(`Server unavailable: ${error.message}`); } }
  function applyUser() {
    const avatar = $('#profileBtn'); if (avatar && state.user) { avatar.textContent = state.user.avatar ? '' : state.user.initials; avatar.classList.toggle('has-img', Boolean(state.user.avatar)); avatar.style.backgroundImage = state.user.avatar ? `url('${state.user.avatar}')` : ''; avatar.title = `${state.user.name} (@${state.user.username})`; avatar.style.backgroundColor = avColor(state.user.username); avatar.style.color = '#10170d'; }
    const sideName = $('.profile-info strong, .profile-info .name'); if (sideName && state.user) sideName.textContent = state.user.name;
    const first = state.user.name.split(' ')[0]; const side = $('.profile .avatar'); if (side) { side.textContent = state.user.avatar ? '' : state.user.initials; side.classList.toggle('has-img', Boolean(state.user.avatar)); side.style.backgroundImage = state.user.avatar ? `url('${state.user.avatar}')` : ''; side.style.backgroundColor = avColor(state.user.username); side.style.color = '#10170d'; }
    const pname = $('.profile-info strong'); if (pname) pname.textContent = state.user.name; const psub = $('.profile-info small'); if (psub) psub.textContent = `@${state.user.username} · online`;
    const ws = $('#workspaceSwitch strong'); if (ws) ws.textContent = `${first}'s space`; const ws2 = $('#workspaceSwitch small'); if (ws2) ws2.textContent = `@${state.user.username}`; const crumb = $('.crumb strong'); if (crumb) crumb.textContent = `${first}'s space`;
    window.dispatchEvent(new CustomEvent('hc:user', { detail: state.user }));
    const greeting = $('.page-heading h1'); if (greeting && state.user) greeting.firstChild.textContent = `Welcome, ${state.user.name.split(' ')[0]} `;
    $('#connectionsBtn')?.remove();
    if (!$('#signOutBtn')) { const actions = $('.top-actions'); if (actions) { const button = document.createElement('button'); button.className = 'outline-button'; button.id = 'signOutBtn'; button.textContent = 'Sign out'; button.addEventListener('click', async () => { await api('/auth/logout', { method: 'POST', body: '{}' }).catch(() => {}); location.reload(); }); actions.appendChild(button); } }
  }
  function injectAuthStyles() {
    if ($('#authStyles')) return; const style = document.createElement('style'); style.id = 'authStyles';
    style.textContent = `
      #authGate{position:fixed;inset:0;z-index:100;display:grid;place-items:center;overflow:auto;padding:24px;background:radial-gradient(900px 500px at 50% -10%,rgba(185,240,124,.10),transparent 60%),var(--bg,#0d1110);color:var(--text,#edf3ee)}
      #authGate .auth-card{width:min(420px,100%);background:var(--panel,#171d1b);border:1px solid var(--line,#2a3430);border-radius:16px;padding:32px 30px 26px;box-shadow:0 24px 70px rgba(0,0,0,.45)}
      #authGate .auth-brand{display:flex;align-items:center;gap:10px;margin-bottom:22px;font-weight:700;font-size:18px;letter-spacing:.2px}
      #authGate .auth-logo{width:32px;height:32px;border-radius:9px;background:var(--mint,#b9f07c);color:#10170d;display:grid;place-items:center;font-weight:800}
      #authGate h2{margin:0 0 4px;font-size:22px;font-weight:700}
      #authGate .auth-sub{margin:0 0 20px;color:var(--muted,#8a9892);font-size:13.5px;line-height:1.45}
      #authGate .auth-social{display:grid;gap:10px;margin-bottom:6px}
      #authGate .auth-social a{display:flex;align-items:center;justify-content:center;gap:10px;padding:11px 14px;border:1px solid var(--line,#2a3430);border-radius:10px;background:#11161400;color:var(--text,#edf3ee);text-decoration:none;font-size:14px;font-weight:600;transition:background .15s,border-color .15s}
      #authGate .auth-social a:hover{background:rgba(255,255,255,.05);border-color:#3b4943}
      #authGate .auth-social a small{color:var(--muted,#8a9892);font-weight:400}
      #authGate .auth-or{display:flex;align-items:center;gap:12px;margin:18px 0;color:var(--muted,#8a9892);font-size:12px}
      #authGate .auth-or::before,#authGate .auth-or::after{content:"";flex:1;height:1px;background:var(--line,#2a3430)}
      #authGate label{display:block;margin-bottom:14px;font-size:12.5px;font-weight:600;color:var(--soft,#c6d1cb)}
      #authGate input{display:block;width:100%;margin-top:6px;padding:11px 12px;border-radius:10px;border:1px solid var(--line,#2a3430);background:var(--bg,#0d1110);color:var(--text,#edf3ee);font:inherit;font-size:14.5px;outline:none;transition:border-color .15s,box-shadow .15s}
      #authGate input:focus{border-color:var(--mint,#b9f07c);box-shadow:0 0 0 3px rgba(185,240,124,.16)}
      #authGate input:-webkit-autofill{-webkit-box-shadow:0 0 0 100px var(--bg,#0d1110) inset;-webkit-text-fill-color:var(--text,#edf3ee);caret-color:var(--text,#edf3ee)}
      #authGate .auth-pass{position:relative}#authGate .auth-pass input{padding-right:64px}
      #authGate .auth-eye{position:absolute;right:8px;bottom:7px;background:none;border:0;color:var(--muted,#8a9892);font-size:12px;cursor:pointer;padding:4px 6px;border-radius:6px}
      #authGate .auth-eye:hover{color:var(--text,#edf3ee)}
      #authGate label small{display:block;margin-top:5px;font-weight:400;font-size:11.5px;color:var(--muted)}#authGate label small.ok{color:var(--mint,#b9f07c)}#authGate label small.bad{color:#ff9b9b}
      #authGate .auth-row{display:flex;justify-content:flex-end;margin:-6px 0 14px}
      #authGate .auth-link{background:none;border:0;color:var(--mint,#b9f07c);cursor:pointer;font-size:12.5px;padding:0}
      #authGate .auth-link:hover{text-decoration:underline}
      #authGate #authError{margin:0 0 12px;min-height:0;font-size:13px;line-height:1.4;color:#ff9b9b}
      #authGate #authError:not(:empty){padding:10px 12px;border-radius:10px;background:rgba(255,120,120,.09);border:1px solid rgba(255,120,120,.25)}
      #authGate #authError.ok{color:var(--mint,#b9f07c);background:rgba(185,240,124,.08);border-color:rgba(185,240,124,.25)}
      #authGate #authSubmit{width:100%;padding:12px;border:0;border-radius:10px;background:var(--mint,#b9f07c);color:#10170d;font-size:14.5px;font-weight:700;cursor:pointer;transition:filter .15s}
      #authGate #authSubmit:hover{filter:brightness(1.06)}#authGate #authSubmit:disabled{opacity:.6;cursor:wait}
      #authGate .auth-switch{margin:18px 0 0;text-align:center;font-size:13.5px;color:var(--muted,#8a9892)}
      #authGate .auth-diag{margin:12px 0 0;padding:10px 12px;border-radius:10px;background:var(--bg,#0d1110);border:1px solid var(--line,#2a3430);color:var(--soft,#c6d1cb);font:11.5px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;user-select:all}
      #authGate .auth-foot{margin:14px 0 0;text-align:center;font-size:11.5px;color:var(--muted,#8a9892)}
      @media (max-width:480px){#authGate .auth-card{padding:24px 20px}}`;
    document.head.appendChild(style);
  }
  async function runDiagnostics() {
    const lines = []; const add = (ok, text) => lines.push(`${ok ? 'OK    ' : 'FAIL  '}${text}`); const origin = location.origin;
    add(location.protocol === 'http:' || location.protocol === 'https:', `Page address: ${location.href}`);
    if (location.protocol === 'file:') lines.push('      -> Open http://localhost:4173 instead of opening the file directly.');
    add(navigator.cookieEnabled, `Browser cookies enabled: ${navigator.cookieEnabled}`);
    const probe = async (label, path, init, expect) => {
      const started = performance.now();
      try { const res = await fetch(path, { credentials: 'same-origin', ...init }); const ms = Math.round(performance.now() - started); const ok = expect.includes(res.status); add(ok, `${label} -> HTTP ${res.status} in ${ms} ms`); return res; }
      catch (error) { add(false, `${label} -> ${error.name}: ${error.message}`); lines.push('      -> The request never reached the server. Is the server window still open (start-hackconnect.cmd)? Try a private/incognito window to rule out a browser extension (ad/privacy blockers can block requests).'); return null; }
    };
    const health = await probe('Server health (GET /health)', '/health', {}, [200]);
    const providers = await probe('Sign-in options (GET /api/auth/providers)', '/api/auth/providers', {}, [200]);
    if (providers?.ok) { const { providers: p } = await providers.clone().json(); lines.push(`      Google sign-in configured: ${p.google}, GitHub sign-in configured: ${p.github}`); }
    await probe('Sign-in request (POST /api/auth/login, expect a rejection)', '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect' }, body: JSON.stringify({ email: 'connection-check@example.invalid', password: 'connection-check-1' }) }, [401, 429]);
    if (health?.ok) lines.push('\nThe browser can reach the server. If sign-in still fails, copy this report and the exact message you see.'); else lines.push('\nThe browser cannot talk to the server. Fix that first (see the hint above), then retry.');
    return lines.join('\n');
  }
  function showAuth(message = '') {
    if ($('#authGate')) { if (message) { const box = $('#authError'); box.classList.remove('ok'); box.textContent = message; } return; }
    injectAuthStyles(); document.body.classList.add('auth-locked');
    const gate = document.createElement('div'); gate.id = 'authGate'; gate.setAttribute('role', 'dialog'); gate.setAttribute('aria-modal', 'true'); gate.setAttribute('aria-labelledby', 'authTitle');
    gate.innerHTML = `<form id="authForm" class="auth-card" novalidate>
      <div class="auth-brand"><img src="/logo-mark.svg" alt="" width="34" height="34" style="border-radius:10px">hack<span style="color:var(--mint,#b9f07c);margin-left:-8px">connect</span></div>
      <h2 id="authTitle">Welcome back</h2><p class="auth-sub" id="authSub">Sign in to your team's build rooms.</p>
      <div id="authProviders" class="auth-social"></div><div class="auth-or" id="authOr">or continue with email</div>
      <label id="authNameRow" style="display:none">Full name<input id="authName" autocomplete="name" placeholder="Ada Lovelace"></label>
      <label id="authUserRow" style="display:none">Username<input id="authUser" autocomplete="username" placeholder="ada-lovelace" maxlength="30" spellcheck="false"><small id="authUserHint">People find and invite you by this. You can change it later.</small></label>
      <label>Email<input id="authEmail" type="email" required autocomplete="email" placeholder="you@example.com" inputmode="email"></label>
      <label class="auth-pass-label">Password<span class="auth-pass"><input id="authPassword" type="password" required minlength="10" autocomplete="current-password" placeholder="At least 10 characters"><button type="button" class="auth-eye" id="authEye" aria-label="Show password">Show</button></span></label>
      <div class="auth-row" id="authForgotRow"><button type="button" class="auth-link" id="authForgot">Forgot your password?</button></div>
      <p id="authError" role="alert">${esc(message)}</p>
      <button id="authSubmit" type="submit">Sign in</button>
      <p class="auth-switch"><span id="authSwitchText">New to HackConnect?</span> <button type="button" class="auth-link" id="authToggle">Create an account</button></p>
      <p class="auth-foot">By continuing you agree to share only what you choose with your team.<br><button type="button" class="auth-link" id="authDiag" style="margin-top:8px">Having trouble? Run a connection check</button></p><pre class="auth-diag" id="authDiagOut" hidden></pre></form>`;
    document.body.appendChild(gate); let signup = false; const nameInput = $('#authName', gate); const errorBox = $('#authError', gate);
    const setMode = (next) => {
      signup = next; $('#authNameRow', gate).style.display = signup ? '' : 'none'; $('#authUserRow', gate).style.display = signup ? '' : 'none'; $('#authForgotRow', gate).style.display = signup ? 'none' : ''; nameInput.required = signup;
      $('#authTitle', gate).textContent = signup ? 'Create your account' : 'Welcome back'; $('#authSub', gate).textContent = signup ? 'Start building with your team in minutes.' : "Sign in to your team's build rooms.";
      $('#authSubmit', gate).textContent = signup ? 'Create account' : 'Sign in'; $('#authSwitchText', gate).textContent = signup ? 'Already have an account?' : 'New to HackConnect?'; $('#authToggle', gate).textContent = signup ? 'Sign in' : 'Create an account';
      $('#authPassword', gate).autocomplete = signup ? 'new-password' : 'current-password'; $$('#authProviders a', gate).forEach(link => { link.firstElementChild.nextSibling.textContent = `${signup ? 'Sign up' : 'Continue'} with ${link.dataset.label}`; });
    };
    let userEdited = false; let userTimer = null; const userInput = $('#authUser', gate); const userHint = $('#authUserHint', gate);
    const slugify = (v) => String(v).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
    const checkUser = () => { clearTimeout(userTimer); const v = userInput.value.trim().toLowerCase().replace(/^@/, ''); if (!v) { userHint.className = ''; userHint.textContent = 'We will pick one from your name if you leave this empty.'; return; } userTimer = setTimeout(async () => { try { const r = await fetch(`/api/auth/username-available?u=${encodeURIComponent(v)}`).then(x => x.json()); userHint.className = r.valid && r.available ? 'ok' : 'bad'; userHint.textContent = !r.valid ? `Use 3-30 lowercase letters, numbers, - or _${r.suggestion ? ` (try @${r.suggestion})` : ''}` : r.available ? `@${v} is available` : `@${v} is already taken`; } catch { /* offline: the server validates anyway */ } }, 260); };
    nameInput.addEventListener('input', () => { if (!userEdited) { userInput.value = slugify(nameInput.value); checkUser(); } }); userInput.addEventListener('input', () => { userEdited = true; checkUser(); });
    $('#authForgot', gate).addEventListener('click', () => forgotPassword($('#authEmail', gate).value));
    $('#authDiag', gate).addEventListener('click', async () => { const out = $('#authDiagOut', gate); out.hidden = false; out.textContent = 'Checking…'; out.textContent = await runDiagnostics(); });
    $('#authToggle', gate).addEventListener('click', () => { errorBox.textContent = ''; errorBox.classList.remove('ok'); setMode(!signup); });
    $('#authEye', gate).addEventListener('click', () => { const input = $('#authPassword', gate); const show = input.type === 'password'; input.type = show ? 'text' : 'password'; $('#authEye', gate).textContent = show ? 'Hide' : 'Show'; $('#authEye', gate).setAttribute('aria-label', show ? 'Hide password' : 'Show password'); });
    $('#authForm', gate).addEventListener('submit', async event => {
      event.preventDefault(); event.stopImmediatePropagation(); const button = $('#authSubmit', gate); errorBox.textContent = ''; errorBox.classList.remove('ok');
      const email = $('#authEmail', gate).value.trim(); const password = $('#authPassword', gate).value;
      if (!email || !password) { errorBox.textContent = 'Enter your email and password.'; return; } if (signup && !nameInput.value.trim()) { errorBox.textContent = 'Tell us your name so teammates recognise you.'; return; }
      button.disabled = true; const label = button.textContent; button.textContent = 'Please wait…';
      try {
        const body = { email, password, ...(signup ? { name: nameInput.value.trim(), username: userInput.value.trim() } : {}) }; const out = await api(signup ? '/auth/signup' : '/auth/login', { method: 'POST', body: JSON.stringify(body) });
        if (out.needsVerification) { setMode(false); errorBox.classList.add('ok'); errorBox.textContent = `Account created. Open the confirmation link we emailed you, then sign in. ${deliveryNote(out.delivery)}`; return; }
        gate.remove(); document.body.classList.remove('auth-locked'); await acceptPendingInvite(); await loadBootstrap(); await approveDeviceFromUrl();
      } catch (error) { errorBox.textContent = error.message; if (/Cannot reach/.test(error.message)) { const out = $('#authDiagOut', gate); out.hidden = false; out.textContent = 'Checking…'; out.textContent = await runDiagnostics(); } } finally { if (gate.isConnected) { button.disabled = false; button.textContent = label; } }
    }, true);
    fetch('/api/auth/providers').then(r => r.json()).then(({ providers }) => {
      $('#authProviders', gate).innerHTML = [['google', 'Google', '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z"/><path fill="#FBBC05" d="M10.5 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C.9 16.4 0 20.1 0 24s.9 7.6 2.6 10.8l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.9 2.3-8.4 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>'], ['github', 'GitHub', '<svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>']].map(([id, label, icon]) => `<a href="/api/auth/oauth/${id}/start" data-label="${label}" ${providers[id] ? '' : `title="${label} sign-in is not set up on this server yet"`}>${icon}Continue with ${label}</a>`).join('');
    }).catch(() => { $('#authProviders', gate).remove(); $('#authOr', gate).remove(); });
    $('#authEmail', gate).focus();
  }
  async function acceptPendingInvite() { const token = new URLSearchParams(location.search).get('invite'); if (!token) return; try { const result = await api(`/invites/${encodeURIComponent(token)}/accept`, { method: 'POST', body: '{}' }); notify(`Joined ${result.name}`); } catch (error) { notify(error.message); } history.replaceState(null, '', location.pathname); }
  async function createInviteLink(role = 'editor', { copy = true } = {}) { if (!state.currentProject) { notify('Open a project first, then invite teammates to it'); return null; } try { const invite = await api(`/projects/${state.currentProject.id}/invites`, { method: 'POST', body: JSON.stringify({ role }) }); const link = `${location.origin}/?invite=${invite.token}`; if (copy) { try { await navigator.clipboard.writeText(link); notify(`${role === 'viewer' ? 'View-only' : 'Editor'} link copied (valid 7 days)`); } catch { window.prompt('Copy this invite link', link); } } return link; } catch (error) { notify(error.message); return null; } }
  // Share: pick what the link allows, then copy it.
  function openShare() {
    if (!state.currentProject) { notify('Open a project first, then share it'); return; }
    let role = localStorage.getItem('hc-share-role') === 'viewer' ? 'viewer' : 'editor';
    const opt = (id, icon, title, sub) => `<label class="share-opt"><input type="radio" name="shareRole" value="${id}"><span class="share-ic">${icon}</span><span class="share-tx"><b>${title}</b><small>${sub}</small></span></label>`;
    const m = modal({ title: 'Share this project', sub: `Anyone with the link who signs in can join <b>${esc(state.currentProject.name)}</b>.`, width: 460,
      body: `<div class="share-opts">${opt('editor', '✎', 'Can edit', 'Change files, run code and chat')}${opt('viewer', '👁', 'Can view', 'Read-only: browse files, follow along and chat')}</div><div class="share-out" id="shareOut" hidden><input class="inp" id="shareLink" readonly aria-label="Invite link"><button class="outline-button btn-sm" id="shareCopy" type="button">Copy</button></div><p class="muted small" style="margin:10px 0 0">Links expire after 7 days. To add someone with a specific role, use Invite.</p>`,
      actions: [{ label: 'Close' }, { label: 'Copy link', kind: 'primary', keepOpen: true, onClick: async () => { const link = await createInviteLink(role, { copy: false }); if (!link) return false; $('#shareOut', m.el).hidden = false; const inp = $('#shareLink', m.el); inp.value = link; inp.select(); try { await navigator.clipboard.writeText(link); notify(`${role === 'viewer' ? 'View-only' : 'Editor'} link copied`); } catch { /* user can copy from the field */ } return false; } }] });
    const sync = () => { $$('.share-opt', m.el).forEach(l => { const r = $('input', l); r.checked = r.value === role; l.classList.toggle('on', r.checked); }); $('#shareOut', m.el).hidden = true; };
    $$('.share-opt input', m.el).forEach(r => r.addEventListener('change', () => { role = r.value; localStorage.setItem('hc-share-role', role); sync(); })); sync();
    $('#shareCopy', m.el).addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#shareLink', m.el).value); notify('Link copied'); } catch { $('#shareLink', m.el).select(); } });
  }
  // "More" menu keeps the toolbar short: full screen, zoom, GitHub sync, extensions.
  function openMore() {
    const open0 = document.querySelector('.more-menu'); if (open0) { open0._close(); return; } const btn = $('#wsMoreBtn'); const r = btn.getBoundingClientRect(); const menu = document.createElement('div'); menu.className = 'more-menu'; menu.setAttribute('role', 'menu');
    const lvl = $('#ideZoomLvl')?.textContent || '100%';
    menu.innerHTML = `<button role="menuitem" data-go="#ideFull"><span>⛶</span>Full screen</button><div class="mm-row"><span>🔍</span>Zoom<span class="mm-zoom"><button data-go="#ideZoomOut" aria-label="Zoom out">−</button><button data-go="#ideZoomLvl" class="mm-lvl" title="Reset zoom">${esc(lvl)}</button><button data-go="#ideZoomIn" aria-label="Zoom in">＋</button></span></div><div class="mm-sep"></div><button role="menuitem" data-go="#wsGithubBtn"><span>↥</span>Sync to GitHub</button><button role="menuitem" data-go="#wsExtBtn"><span>◫</span>Extensions &amp; settings</button>`;
    document.body.appendChild(menu); menu.style.top = `${r.bottom + 6}px`; menu.style.right = `${Math.max(8, innerWidth - r.right)}px`;
    const close = () => { menu.remove(); document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onKey, true); };
    const onDoc = (e) => { if (!menu.contains(e.target) && !btn.contains(e.target)) close(); }; const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDoc, true); document.addEventListener('keydown', onKey, true); menu._close = close;
    $$('[data-go]', menu).forEach(b => b.addEventListener('click', () => { const go = b.dataset.go; $(go)?.click(); if (go.startsWith('#ideZoom')) { const l = $('.mm-lvl', menu); if (l) l.textContent = $('#ideZoomLvl')?.textContent || ''; } else close(); }));
  }
  async function showConnections() {
    if ($('#connectionsDialog')) return;
    let info; try { info = await api('/me/identities'); } catch (error) { notify(error.message); return; }
    const overlay = document.createElement('div'); overlay.id = 'connectionsDialog'; overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', 'Connected accounts');
    Object.assign(overlay.style, { position: 'fixed', inset: '0', zIndex: 90, display: 'grid', placeItems: 'center', background: 'rgba(8,12,8,.8)' });
    const rows = [['github', 'GitHub', 'Lets you sync workspaces to your repositories with your own permissions.'], ['google', 'Google', 'Sign in with your Google account.']].map(([id, label, why]) => {
      const linked = info.identities.find(i => i.provider === id); const configured = info.providers[id];
      const action = linked ? `<button class="outline-button" data-disconnect="${id}">Disconnect</button>` : configured ? `<a class="primary-button" href="/api/auth/oauth/${id}/start?link=1" style="text-decoration:none;padding:8px 14px">Connect</a>` : `<span class="subtle">Not set up on this server (see docs/ENVIRONMENT.md)</span>`;
      return `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 0;border-top:1px solid var(--line)"><div><b style="display:inline-flex;align-items:center;gap:8px">${window.HCLogos?.[id] || ''}${label}</b>${linked ? ` &middot; <span style="color:var(--mint)">connected as ${esc(linked.handle || linked.email || '')}</span>${id === 'github' && !linked.hasRepoAccess ? ' <small>(sign-in only)</small>' : ''}` : ''}<br><small class="subtle">${why}</small></div>${action}</div>`;
    }).join('');
    overlay.innerHTML = `<div style="width:min(480px,92vw);padding:24px;border:1px solid var(--line);border-radius:12px;background:var(--panel,#121a12)"><h2 style="margin:0 0 4px">Connected accounts</h2><p class="subtle" style="margin:0 0 12px">Signed in as ${esc(state.user.email)}${info.hasPassword ? '' : ' (no password set: your connected account is your login)'}</p>${rows}<div style="text-align:right;margin-top:14px"><button class="outline-button" id="connectionsClose">Close</button></div></div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove(); $('#connectionsClose', overlay).addEventListener('click', close); overlay.addEventListener('click', event => { if (event.target === overlay) close(); }); overlay.addEventListener('keydown', event => { if (event.key === 'Escape') close(); }); $('#connectionsClose', overlay).focus();
    $$('[data-disconnect]', overlay).forEach(button => button.addEventListener('click', async () => { try { await api(`/auth/identities/${button.dataset.disconnect}`, { method: 'DELETE' }); notify('Disconnected'); close(); showConnections(); } catch (error) { notify(error.message); } }));
  }
  async function loadTunnels() {
    if (!state.currentProject) return;
    try {
      const { tunnels } = await api(`/projects/${state.currentProject.id}/tunnels`); let strip = $('#tunnelStrip');
      if (!strip) { const anchor = $('#peerStrip') || $('#codeInput')?.parentElement; if (!anchor) return; strip = document.createElement('div'); strip.id = 'tunnelStrip'; Object.assign(strip.style, { padding: '4px 10px', fontSize: '12px' }); anchor.insertAdjacentElement('beforebegin', strip); }
      strip.innerHTML = tunnels.map(t => `<span>&#128279; ${esc(t.by)}'s app on :${t.port} (${esc(t.visibility)}) - <a href="${esc(t.previewUrl)}" target="_blank" rel="noopener noreferrer">open (secure preview)</a></span>`).join(' &middot; ');
    } catch { /* ignore */ }
  }
  async function approveDeviceFromUrl() {
    const code = new URLSearchParams(location.search).get('device'); if (!code) return; history.replaceState(null, '', location.pathname);
    if (!window.confirm(`Approve the HackConnect Local Bridge on your computer?\n\nCode: ${code}\nOnly continue if you just ran "hackconnect login".`)) return;
    try { await api('/device/approve', { method: 'POST', body: JSON.stringify({ userCode: code }) }); notify('Local Bridge approved. Return to your terminal.'); } catch (error) { notify(error.message); }
  }
  function handleOAuthReturn() { const params = new URLSearchParams(location.search); const err = params.get('auth_error'); const linked = params.get('linked'); if (err || linked) history.replaceState(null, '', location.pathname); if (linked) notify(`${linked === 'github' ? 'GitHub' : linked} connected`); return err; }
  const deliveryNote = (delivery) => delivery === 'smtp' ? 'Check your inbox.' : 'No mail server is set up yet, so the link was printed in the HackConnect server window and saved in .hackconnect/outbox/.';
  async function forgotPassword(prefill = '') {
    const email = window.prompt('Enter the email of your account and we will send a reset link', prefill); if (!email) return;
    try { const out = await api('/auth/forgot', { method: 'POST', body: JSON.stringify({ email }) }); const box = $('#authError'); const message = `If that account exists, a reset link is on its way. ${deliveryNote(out.delivery)}`; if (box) { box.style.color = 'var(--mint)'; box.textContent = message; } else notify(message); } catch (error) { notify(error.message); }
  }
  function showReset(token) {
    const overlay = document.createElement('div'); overlay.id = 'resetDialog'; overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', 'Choose a new password');
    Object.assign(overlay.style, { position: 'fixed', inset: '0', zIndex: 110, display: 'grid', placeItems: 'center', background: 'rgba(8,12,8,.94)' });
    overlay.innerHTML = `<form style="width:min(380px,92vw);display:grid;gap:12px;padding:28px;border:1px solid var(--line,#334);border-radius:12px;background:var(--panel,#121a12);color:inherit"><h2 style="margin:0">Choose a new password</h2><label>New password (10+ characters)<input id="resetPassword" type="password" required minlength="10" autocomplete="new-password" style="width:100%"></label><p id="resetError" role="alert" style="color:#ff8a8a;margin:0;min-height:1.2em"></p><button class="primary-button">Save password</button></form>`;
    document.body.appendChild(overlay); $('#resetPassword', overlay).focus();
    $('form', overlay).addEventListener('submit', async event => { event.preventDefault(); try { await api('/auth/reset', { method: 'POST', body: JSON.stringify({ token, password: $('#resetPassword', overlay).value }) }); overlay.remove(); notify('Password updated. Sign in with your new password.'); if (!state.user) showAuth('Password updated. Sign in with your new password.'); } catch (error) { $('#resetError', overlay).textContent = error.message; } });
  }
  async function handleEmailLinks() {
    const params = new URLSearchParams(location.search); const verify = params.get('verify'); const reset = params.get('reset'); if (!verify && !reset) return;
    history.replaceState(null, '', location.pathname);
    if (verify) { try { await api('/auth/verify', { method: 'POST', body: JSON.stringify({ token: verify }) }); notify('Email confirmed. You can sign in now.'); if (state.user) state.user.emailVerified = true; } catch (error) { notify(error.message); } }
    if (reset) showReset(reset);
  }
  function showVerifyBanner() {
    $('#verifyBanner')?.remove(); if (!state.user || state.user.emailVerified !== false) return;
    const bar = document.createElement('div'); bar.id = 'verifyBanner'; bar.setAttribute('role', 'status'); Object.assign(bar.style, { padding: '8px 16px', background: 'rgba(246,193,119,.12)', borderBottom: '1px solid var(--line)', fontSize: '13px', display: 'flex', gap: '12px', alignItems: 'center' });
    bar.innerHTML = `<span>Please confirm your email address (${esc(state.user.email)}).</span><button class="outline-button" id="resendVerify">Resend link</button>`; $('.topbar')?.insertAdjacentElement('afterend', bar);
    $('#resendVerify', bar).addEventListener('click', async () => { try { const out = await api('/auth/resend-verification', { method: 'POST', body: '{}' }); notify(out.alreadyVerified ? 'Already confirmed' : `Link sent. ${deliveryNote(out.delivery)}`); } catch (error) { notify(error.message); } });
  }
  async function init() { const oauthError = handleOAuthReturn(); await handleEmailLinks(); try { const me = await api('/auth/me'); state.user = me.user; await acceptPendingInvite(); await loadBootstrap(); if (oauthError) notify(oauthError); await approveDeviceFromUrl(); } catch { showAuth(oauthError || ''); } }
  // Empty state for the Live workspace: shown while no project is open. "Open a project" lists the user's projects.
  function syncWorkspaceEmpty() {
    const panel = $('#ide .editor-panel'); if (!panel) return; let box = $('#wsEmpty', panel);
    if (state.currentProject) { box?.remove(); return; }
    if (box) return;
    box = document.createElement('div'); box.id = 'wsEmpty'; box.className = 'ws-empty';
    box.innerHTML = `<div class="we-card"><div class="we-ic"><svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></div><h2>Open a project</h2><p>Pick one of your projects to start coding together in real time.</p><button class="primary-button we-open" id="weOpen" aria-haspopup="menu">Open a project <span aria-hidden="true">▾</span></button><div class="we-hint">Tip: right-click anywhere here to open the list too</div></div>`;
    panel.appendChild(box);
    const show = (e) => { e.preventDefault(); e.stopPropagation(); openProjectPicker(e.type === 'contextmenu' ? { x: e.clientX, y: e.clientY } : $('#weOpen', box).getBoundingClientRect(), e.type === 'contextmenu' ? null : $('#weOpen', box)); };
    $('#weOpen', box).addEventListener('click', show); box.addEventListener('contextmenu', show);
  }
  function openProjectPicker(anchor, anchorEl = null) {
    const open0 = document.querySelector('.pick-menu'); if (open0) { open0._close(); if (anchorEl) return; } const projects = state.projects || []; const menu = document.createElement('div'); menu.className = 'pick-menu'; menu.setAttribute('role', 'menu');
    const row = (p) => `<button role="menuitem" class="pm-row" data-id="${esc(p.id)}"><span class="pm-dot" style="background:${avColor(p.name || '?')}">${esc((p.name || '?').slice(0, 1).toUpperCase())}</span><span class="pm-tx"><b>${esc(p.name || 'Untitled')}</b><small>${esc(p.description || (p.updatedAt ? 'Updated ' + ago(p.updatedAt) : 'Project'))}</small></span></button>`;
    menu.innerHTML = projects.length ? `<div class="pm-h">Your projects <i>${projects.length}</i></div>${projects.length > 6 ? '<input class="inp pm-q" placeholder="Search projects…" aria-label="Search projects">' : ''}<div class="pm-list">${projects.map(row).join('')}</div>` : `<div class="pm-empty"><b>No projects yet</b><small>Create or import one from My projects.</small><button class="outline-button btn-sm" id="pmGo">Go to My projects</button></div>`;
    document.body.appendChild(menu);
    const w = menu.offsetWidth, h = menu.offsetHeight; let x = anchor.x ?? anchor.left, y = anchor.y ?? anchor.bottom + 6;
    if (anchor.width) x = anchor.left + anchor.width / 2 - w / 2; x = Math.max(8, Math.min(innerWidth - w - 8, x)); y = Math.max(8, Math.min(innerHeight - h - 8, y)); Object.assign(menu.style, { left: x + 'px', top: y + 'px' });
    const close = () => { menu.remove(); document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onKey, true); };
    const onDoc = (e) => { if (!menu.contains(e.target) && !anchorEl?.contains(e.target)) close(); }; const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDoc, true); document.addEventListener('keydown', onKey, true); menu._close = close;
    $$('.pm-row', menu).forEach(b => b.addEventListener('click', () => { close(); openProject(b.dataset.id); }));
    $('#pmGo', menu)?.addEventListener('click', () => { close(); document.querySelector('[data-view="projects"]')?.click(); });
    const q = $('.pm-q', menu); if (q) { q.focus(); q.addEventListener('input', () => { const t = q.value.trim().toLowerCase(); $$('.pm-row', menu).forEach(b => { b.hidden = t && !b.textContent.toLowerCase().includes(t); }); }); }
  }
  setInterval(syncWorkspaceEmpty, 400);
  async function openProject(id) { try { const data = await api(`/projects/${encodeURIComponent(id)}`); state.currentProject = data.project; renderWorkspace(data.project, data.messages || []); const workspaceButton = $('[data-view="workspace"]'); if (workspaceButton) workspaceButton.click(); } catch (error) { notify(error.message); } }
  const editorText = () => (state.editor ? (state.editor.getValue() ?? '') : $('#codeInput').value);
  function connectCollab(project) {
    state.unbind?.(); state.unbind = null; state.collab?.close(); state.collab = null; state.following = null;
    if (!window.HCCollab) return;
    state.collab = HCCollab.connect(project.id, {
      user: state.user,
      onStatus: status => { const label = { connecting: 'Connecting…', connected: 'Live · all changes synced', reconnecting: 'Reconnecting — edits are kept locally', offline: 'Offline — editing locally', denied: 'Access lost' }[status]; if (label && state.currentProject?.id === project.id) { $('#saveState').textContent = label; state.connLabel = label.split(' ·')[0].split(' —')[0]; renderStatusBar(); } if (status === 'connected') bindActive(); },
      onFiles: names => { if (state.currentProject?.id !== project.id) return; const known = state.currentProject.files; for (const name of names) if (known[name] === undefined) known[name] = ''; for (const name of Object.keys(known)) if (!names.includes(name) && state.collab?.isSynced()) delete known[name]; renderExplorer(state.activePath); },
      onPeers: peers => renderPeers(peers),
      onDenied: () => notify('You no longer have access to this project')
    });
  }
  function bindActive() {
    if (!state.collab?.isSynced() || !state.currentProject) return;
    state.unbind?.(); state.unbindPreview?.(); state.unbindPreview = null; const path = state.activePath; $('#activeFile').textContent = path; const onChange = () => { updateLineNumbers(); $('#saveState').textContent = 'Live · all changes synced'; };
    if (state.editor) { state.unbind = HCCollab.bindEditor(state.editor, state.collab, path, { onChange }); state.editor.updateOptions({ readOnly: !canWrite() }); } else state.unbind = state.collab.bind($('#codeInput'), path, { onChange }); renderStatusBar(); updateLineNumbers();
  }
  function renderPeers(peers) {
    let strip = $('#peerStrip'); if (!strip) { const editor = $('#codeInput')?.parentElement; if (!editor) return; strip = document.createElement('div'); strip.id = 'peerStrip'; strip.setAttribute('aria-live', 'polite'); Object.assign(strip.style, { display: 'flex', gap: '8px', flexWrap: 'wrap', padding: '4px 10px', fontSize: '12px' }); editor.insertAdjacentElement('beforebegin', strip); }
    strip.innerHTML = peers.map(peer => `<button class="outline-button" data-peer="${peer.clientId}" style="border-color:${esc(peer.color)};padding:2px 8px" title="Follow ${esc(peer.name)}">● ${esc(peer.name)} · ${esc(peer.file || 'idle')}${peer.line ? `:${peer.line}` : ''}${state.following === peer.clientId ? ' (following)' : ''}</button>`).join('') || '<span style="color:var(--muted)">Only you are editing right now</span>';
    $$('[data-peer]', strip).forEach(button => button.addEventListener('click', () => { const id = Number(button.dataset.peer); state.following = state.following === id ? null : id; const peer = peers.find(item => item.clientId === id); if (state.following && peer?.file) selectFile(peer.file, true); renderPeers(peers); }));
    const followed = peers.find(peer => peer.clientId === state.following); if (followed?.file && followed.file !== state.activePath) selectFile(followed.file, true);
  }
  function updateLineNumbers() { if (state.editor) return; const count = Math.max(1, ($('#codeInput').value.match(/\n/g) || []).length + 1); $('#lineNumbers').innerHTML = Array.from({ length: count }, (_, index) => index + 1).join('<br>'); }
  function saveFile() { if (!state.currentProject || state.unbind) return; const path = $('#activeFile').textContent; const content = editorText(); state.currentProject.files[path] = content; $('#saveState').textContent = 'Saving…'; clearTimeout(state.saveTimer); state.saveTimer = setTimeout(async () => { try { await api(`/projects/${state.currentProject.id}/files`, { method: 'PUT', body: JSON.stringify({ path, content }) }); $('#saveState').textContent = 'Synced just now'; } catch (error) { $('#saveState').textContent = 'Save failed'; notify(error.message); } }, 450); }

  function renderMessages(messages) { const target = $('#messages'); if (!target) return; target.innerHTML = messages.map(messageMarkup).join(''); target.scrollTop = target.scrollHeight; }
  function messageMarkup(message) {
    const me = state.user?.id; const rx = Object.entries(message.reactions || {}).map(([emoji, ids]) => `<button type="button" class="rx ${ids.includes(me) ? 'mine' : ''}" data-react="${esc(emoji)}" title="${ids.length} reaction${ids.length === 1 ? '' : 's'}">${esc(emoji)} <span>${ids.length}</span></button>`).join('');
    return `<div class="message ${message.sticker ? 'is-sticker' : ''}" data-message-id="${esc(message.id)}"><b>${esc(message.user)}</b><time>${new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time><p>${esc(message.text)}</p><div class="rx-row">${rx}<button type="button" class="rx add" data-react-pick title="Add reaction" aria-label="Add reaction">☺＋</button></div></div>`;
  }
  function appendMessage(message) { if (message.userId !== state.user?.id) bumpChat(); const target = $('#messages'); if (!target || target.querySelector(`[data-message-id="${message.id}"]`)) return; const wrapper = document.createElement('div'); wrapper.innerHTML = messageMarkup(message); wrapper.firstElementChild.dataset.messageId = message.id; target.appendChild(wrapper.firstElementChild); target.scrollTop = target.scrollHeight; }
  function sendPresence(file = $('#activeFile')?.textContent) { if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify({ type: 'presence', file })); }
  async function connectRoom(projectId) {
    if (state.socket) state.socket.close();
    const mine = state.socketSeq = (state.socketSeq || 0) + 1; let url; try { url = await window.hcSocketUrl(`/ws?projectId=${encodeURIComponent(projectId)}`); } catch { $('#saveState').textContent = 'Offline — retrying…'; return; }
    if (mine !== state.socketSeq) return; state.socket = new WebSocket(url);
    state.socket.addEventListener('open', () => { $('#saveState').textContent = 'Room sync connected'; sendPresence(); });
    state.socket.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.type === 'message.created') appendMessage(message.message); if (message.type === 'message.updated') { const el = $(`#messages [data-message-id="${CSS.escape(message.message.id)}"]`); if (el) { const w = document.createElement('div'); w.innerHTML = messageMarkup(message.message); el.replaceWith(w.firstElementChild); } } if (message.type === 'file.updated' && state.currentProject?.id === projectId && !state.unbind) { state.currentProject.files[message.path] = message.content; if (!state.editor && $('#activeFile').textContent === message.path && document.activeElement !== $('#codeInput')) { $('#codeInput').value = message.content; updateLineNumbers(); } } if (message.type === 'presence') updatePresence(message.members); if (message.type === 'proposals.changed') loadProposals(); if (message.type === 'agent.completed') { showAgentResult(message.result.message, message.result.changes?.length || 0, message.result.proposals?.length || 0); } });
    state.socket.addEventListener('close', event => { if (event.code === 4401) return showAuth('Your session expired'); if (event.code === 4403) { notify('You no longer have access to this project'); return; } if (state.currentProject?.id === projectId) $('#saveState').textContent = 'Offline — retrying…'; });
  }


  async function syncGithub() { if (!state.currentProject) return; try { const status = await api('/integrations/status'); if (!status.github) { if (window.confirm(status.githubSignIn ? 'To sync this workspace to GitHub you need to connect your GitHub account (with repository access).\n\nOpen Connections now?' : 'GitHub is not set up on this server yet. Add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to .env (see docs/ENVIRONMENT.md).')) { if (status.githubSignIn) showConnections(); } return; } } catch (error) { notify(error.message); return; } const owner = window.prompt('GitHub owner or organization'); const repo = window.prompt('GitHub repository name'); if (!owner || !repo) return; try { const result = await api(`/projects/${state.currentProject.id}/github/sync`, { method: 'POST', body: JSON.stringify({ owner, repo }) }); notify(`Synced ${result.synced} files to ${result.repo}`); } catch (error) { notify(error.message); } }

  async function submitChat(event) { event.preventDefault(); event.stopImmediatePropagation(); const input = $('#chatMessage'); const text = input.value.trim(); if (!text || !state.currentProject) return; input.value = ''; try { await api(`/projects/${state.currentProject.id}/messages`, { method: 'POST', body: JSON.stringify({ text }) }); } catch (error) { notify(error.message); } }
  async function createProject(event) { event.preventDefault(); event.stopImmediatePropagation(); const name = $('#projectName').value.trim(); if (!name) return; if ($('#modalTitle')?.textContent === 'Invite your team') { $('#modalBackdrop').classList.remove('show'); $('#modalForm').reset(); createInviteLink(); return; } const description = $('#projectDescription').value.trim(); try { const project = await api('/projects', { method: 'POST', body: JSON.stringify({ name, description }) }); $('#modalBackdrop').classList.remove('show'); $('#modalForm').reset(); state.projects.unshift(project); renderProjects(); notify(`${name} room created`); openProject(project.id); } catch (error) { notify(error.message); } }

  async function getMedia(video = true) { if (state.localStream) return state.localStream; state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video }); const videoElement = document.createElement('video'); videoElement.id = 'localCallVideo'; videoElement.autoplay = true; videoElement.muted = true; videoElement.playsInline = true; Object.assign(videoElement.style, { position: 'fixed', right: '25px', bottom: '25px', width: '180px', border: '1px solid #526642', borderRadius: '8px', zIndex: 8 }); videoElement.srcObject = state.localStream; document.body.appendChild(videoElement); return state.localStream; }
  async function startCall() { try { await getMedia(true); state.socket?.send(JSON.stringify({ type: 'call.started' })); notify('Camera and microphone are live in this room'); } catch (error) { notify(`Call permission denied: ${error.message}`); } }
  async function receiveCallInvite(peerId) { try { await getMedia(true); const peer = await makePeer(peerId, true); const offer = await peer.createOffer(); await peer.setLocalDescription(offer); state.socket?.send(JSON.stringify({ type: 'rtc', signal: { type: 'offer', sdp: offer } })); } catch { notify('A teammate started a call, but camera access is unavailable'); } }
  async function makePeer(peerId, initiator = false) { if (state.peers.has(peerId)) return state.peers.get(peerId); const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }); state.peers.set(peerId, peer); state.localStream?.getTracks().forEach(track => peer.addTrack(track, state.localStream)); peer.onicecandidate = event => { if (event.candidate) state.socket?.send(JSON.stringify({ type: 'rtc', to: peerId, signal: { type: 'candidate', candidate: event.candidate } })); }; peer.ontrack = event => { let video = document.querySelector(`[data-peer-video="${peerId}"]`); if (!video) { video = document.createElement('video'); video.dataset.peerVideo = peerId; video.autoplay = true; video.playsInline = true; Object.assign(video.style, { position: 'fixed', right: '220px', bottom: '25px', width: '180px', border: '1px solid #526642', borderRadius: '8px', zIndex: 8 }); document.body.appendChild(video); } video.srcObject = event.streams[0]; }; return peer; }
  async function handleRtc(message) { if (message.to && message.to !== state.user.id) return; const signal = message.signal; const peer = await makePeer(message.from); if (signal.type === 'offer') { await peer.setRemoteDescription(signal.sdp); const answer = await peer.createAnswer(); await peer.setLocalDescription(answer); state.socket?.send(JSON.stringify({ type: 'rtc', to: message.from, signal: { type: 'answer', sdp: answer } })); } else if (signal.type === 'answer') await peer.setRemoteDescription(signal.sdp); else if (signal.type === 'candidate') await peer.addIceCandidate(signal.candidate); }
  async function shareScreen() { try { const screen = await navigator.mediaDevices.getDisplayMedia({ video: true }); const track = screen.getVideoTracks()[0]; state.peers.forEach(peer => peer.getSenders().find(sender => sender.track?.kind === 'video')?.replaceTrack(track)); track.onended = () => state.localStream?.getVideoTracks()[0] && state.peers.forEach(peer => peer.getSenders().find(sender => sender.track?.kind === 'video')?.replaceTrack(state.localStream.getVideoTracks()[0])); notify('Screen sharing is live'); } catch (error) { notify(`Screen sharing unavailable: ${error.message}`); } }

  document.addEventListener('submit', event => { if (event.target.id === 'modalForm') createProject(event); if (event.target.id === 'chatForm') submitChat(event); }, true);
  $('#codeInput')?.addEventListener('input', () => { updateLineNumbers(); saveFile(); });
  window.HackConnectApp = { openProject, notify };
  window.HC = Object.assign(window.HC || {}, { saveSettings, applySettings, applyUser, iconFor, FOLDER_ICON, fitIde, api, esc, notify, modal, ask, confirmBox, av, avColor, ago, copyText, openProject, openInvite, openExtensions, openAssistantSettings, openConnectAgent, state, createInviteLink, showConnections, bumpChat });
  init();
})();
