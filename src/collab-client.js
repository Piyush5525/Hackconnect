// Browser Yjs client for HackConnect. Bundled to vendor/collab-client.js (npm run build:client).
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as monaco from 'monaco-editor';
import { MonacoBinding } from 'y-monaco';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { unzipSync, strFromU8 } from 'fflate';

const COLORS = ['#7bd88f', '#f6c177', '#9ccfd8', '#eb6f92', '#c4a7e7', '#f3a683', '#6fb1ff'];
const colorFor = (id) => { let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; };

/** Map an index in the pre-change text to the post-change text using a Yjs delta. */
export function transformIndex(index, delta) {
  let oldPos = 0; let shift = 0;
  for (const op of delta) {
    if (op.retain) oldPos += op.retain;
    else if (op.insert) { if (oldPos <= index) shift += typeof op.insert === 'string' ? op.insert.length : 1; }
    else if (op.delete) { if (oldPos + op.delete <= index) shift -= op.delete; else if (oldPos < index) shift -= index - oldPos; oldPos += op.delete; }
  }
  return Math.max(0, index + shift);
}

export function applyTextDiff(ytext, oldValue, newValue, origin) {
  if (oldValue === newValue) return;
  let start = 0; const max = Math.min(oldValue.length, newValue.length);
  while (start < max && oldValue[start] === newValue[start]) start++;
  let endOld = oldValue.length; let endNew = newValue.length;
  while (endOld > start && endNew > start && oldValue[endOld - 1] === newValue[endNew - 1]) { endOld--; endNew--; }
  ytext.doc.transact(() => { if (endOld > start) ytext.delete(start, endOld - start); if (endNew > start) ytext.insert(start, newValue.slice(start, endNew)); }, origin);
}

export function connect(projectId, { user, onStatus = () => {}, onFiles = () => {}, onPeers = () => {}, onDenied = () => {} }) {
  const doc = new Y.Doc(); const files = doc.getMap('files'); const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalStateField('user', { id: user.id, name: user.name, color: colorFor(user.id) });
  let ws = null; let closed = false; let attempt = 0; let timer = null; let synced = false;
  const REMOTE = 'remote';

  const sendFrame = (build) => { if (ws && ws.readyState === 1) { const e = encoding.createEncoder(); build(e); ws.send(encoding.toUint8Array(e)); } };
  doc.on('update', (update, origin) => { if (origin === REMOTE) return; sendFrame((e) => { encoding.writeVarUint(e, 0); syncProtocol.writeUpdate(e, update); }); });
  awareness.on('update', ({ added, updated, removed }, origin) => {
    if (origin !== REMOTE) sendFrame((e) => { encoding.writeVarUint(e, 1); encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(awareness, added.concat(updated, removed))); });
    onPeers(peers());
  });
  files.observe(() => onFiles(Array.from(files.keys()).sort()));

  const peers = () => [...awareness.getStates().entries()].filter(([id, s]) => id !== doc.clientID && s.user).map(([id, s]) => ({ clientId: id, ...s.user, file: s.file || null, line: s.line || null }));

  function open() {
    if (closed) return;
    onStatus(attempt === 0 ? 'connecting' : 'reconnecting');
    window.hcSocketUrl(`/collab?projectId=${encodeURIComponent(projectId)}`).then(connect, () => { if (!closed) timer = setTimeout(open, Math.min(10000, 500 * 2 ** attempt++)); });
  }
  function connect(url) {
    if (closed) return;
    ws = new WebSocket(url); ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      attempt = 0; sendFrame((e) => { encoding.writeVarUint(e, 0); syncProtocol.writeSyncStep1(e, doc); });
      sendFrame((e) => { encoding.writeVarUint(e, 1); encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID])); });
    };
    ws.onmessage = (event) => {
      const d = decoding.createDecoder(new Uint8Array(event.data)); const type = decoding.readVarUint(d);
      if (type === 0) {
        const reply = encoding.createEncoder(); encoding.writeVarUint(reply, 0); const t = syncProtocol.readSyncMessage(d, reply, doc, REMOTE);
        if (encoding.length(reply) > 1) ws.send(encoding.toUint8Array(reply));
        if (t === syncProtocol.messageYjsSyncStep2 && !synced) { synced = true; onStatus('connected'); onFiles(Array.from(files.keys()).sort()); } else if (t === syncProtocol.messageYjsSyncStep2) onStatus('connected');
      } else if (type === 1) awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(d), REMOTE);
    };
    ws.onclose = (event) => {
      awarenessProtocol.removeAwarenessStates(awareness, [...awareness.getStates().keys()].filter((id) => id !== doc.clientID), REMOTE);
      if (closed) return;
      if (event.code === 4401 || event.code === 4403) { closed = true; onStatus('denied'); onDenied(event.code); return; }
      onStatus(navigator.onLine === false ? 'offline' : 'reconnecting');
      timer = setTimeout(open, Math.min(10000, 500 * 2 ** attempt++));
    };
  }
  window.addEventListener('online', () => { if (!closed && ws?.readyState !== 1) { clearTimeout(timer); open(); } });
  open();

  /** Two-way bind a <textarea> to files[path]. Creates the Y.Text if missing. Returns an unbind function. */
  function bind(textarea, path, { onChange = () => {} } = {}) {
    let ytext = files.get(path);
    if (!ytext) { ytext = new Y.Text(); files.set(path, ytext); }
    const LOCAL = Symbol('local');
    textarea.value = ytext.toString();
    const reportCursor = () => { const before = textarea.value.slice(0, textarea.selectionStart); awareness.setLocalStateField('file', path); awareness.setLocalStateField('line', before.split('\n').length); };
    const onInput = () => { applyTextDiff(ytext, ytext.toString(), textarea.value, LOCAL); onChange(); reportCursor(); };
    const observer = (event, transaction) => {
      if (transaction.origin === LOCAL) return;
      const focused = document.activeElement === textarea;
      const start = transformIndex(textarea.selectionStart, event.delta); const end = transformIndex(textarea.selectionEnd, event.delta); const top = textarea.scrollTop;
      textarea.value = ytext.toString(); if (focused) textarea.setSelectionRange(start, end); textarea.scrollTop = top; onChange();
    };
    textarea.addEventListener('input', onInput); textarea.addEventListener('keyup', reportCursor); textarea.addEventListener('click', reportCursor); ytext.observe(observer); reportCursor();
    return () => { textarea.removeEventListener('input', onInput); textarea.removeEventListener('keyup', reportCursor); textarea.removeEventListener('click', reportCursor); ytext.unobserve(observer); };
  }

  return { doc, files, awareness, bind, peers, isSynced: () => synced, close: () => { closed = true; clearTimeout(timer); awareness.destroy(); ws?.close(); doc.destroy(); } };
}

// ---- Monaco editor integration (one bundle so there is exactly one copy of Yjs on the page)
self.MonacoEnvironment = {
  getWorkerUrl(_id, label) {
    const name = label === 'json' ? 'json' : label === 'css' || label === 'scss' || label === 'less' ? 'css' : label === 'html' || label === 'handlebars' || label === 'razor' ? 'html' : label === 'typescript' || label === 'javascript' ? 'ts' : 'editor';
    return `/vendor/monaco/${name}.worker.js`;
  }
};
const LANG = { js: 'javascript', mjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', css: 'css', html: 'html', json: 'json', md: 'markdown', go: 'go', rs: 'rust', java: 'java', rb: 'ruby', sh: 'shell', yml: 'yaml', yaml: 'yaml' };
const languageOf = (path) => LANG[path.split('.').pop().toLowerCase()] || 'plaintext';

const THEMES = {
  hackconnect: { base: 'vs-dark', inherit: true, rules: [{ token: 'comment', foreground: '6b7a73', fontStyle: 'italic' }, { token: 'keyword', foreground: 'b9f07c' }, { token: 'string', foreground: 'f6c177' }, { token: 'number', foreground: '9ccfd8' }, { token: 'type', foreground: 'c4a7e7' }], colors: { 'editor.background': '#101513', 'editor.lineHighlightBackground': '#161d1a', 'editorLineNumber.foreground': '#46534d', 'editorLineNumber.activeForeground': '#b9f07c', 'editorCursor.foreground': '#b9f07c', 'editor.selectionBackground': '#b9f07c33', 'editorIndentGuide.background1': '#1d2522', 'editorWidget.background': '#171d1b', 'editorSuggestWidget.background': '#171d1b', 'scrollbarSlider.background': '#2a343066' } },
  dracula: { base: 'vs-dark', inherit: true, rules: [{ token: 'comment', foreground: '6272a4' }, { token: 'keyword', foreground: 'ff79c6' }, { token: 'string', foreground: 'f1fa8c' }, { token: 'number', foreground: 'bd93f9' }, { token: 'type', foreground: '8be9fd' }], colors: { 'editor.background': '#282a36', 'editor.lineHighlightBackground': '#44475a55', 'editorCursor.foreground': '#f8f8f2', 'editor.selectionBackground': '#44475a' } },
  monokai: { base: 'vs-dark', inherit: true, rules: [{ token: 'comment', foreground: '75715e' }, { token: 'keyword', foreground: 'f92672' }, { token: 'string', foreground: 'e6db74' }, { token: 'number', foreground: 'ae81ff' }, { token: 'type', foreground: '66d9ef' }], colors: { 'editor.background': '#272822', 'editor.lineHighlightBackground': '#3e3d32', 'editorCursor.foreground': '#f8f8f0' } },
  'github-light': { base: 'vs', inherit: true, rules: [{ token: 'comment', foreground: '6e7781' }, { token: 'keyword', foreground: 'cf222e' }, { token: 'string', foreground: '0a3069' }], colors: { 'editor.background': '#ffffff', 'editor.lineHighlightBackground': '#f6f8fa' } }
};
export const THEME_NAMES = [['hackconnect', 'HackConnect Dark'], ['vs-dark', 'Dark+ (VS Code)'], ['dracula', 'Dracula'], ['monokai', 'Monokai'], ['github-light', 'GitHub Light'], ['hc-black', 'High Contrast']];
let themesDefined = false; const defineThemes = () => { if (themesDefined) return; for (const [name, def] of Object.entries(THEMES)) monaco.editor.defineTheme(name, def); themesDefined = true; };
export function setEditorTheme(name) { defineThemes(); monaco.editor.setTheme(THEME_NAMES.some(([n]) => n === name) ? name : 'hackconnect'); }
export function applyEditorOptions(editor, o = {}) {
  editor.updateOptions({ minimap: { enabled: Boolean(o.minimap) }, wordWrap: o.wordWrap ? 'on' : 'off', fontSize: Number(o.fontSize) || 13, tabSize: Number(o.tabSize) || 2, fontLigatures: Boolean(o.ligatures), bracketPairColorization: { enabled: o.brackets !== false }, cursorSmoothCaretAnimation: o.smoothCaret ? 'on' : 'off', cursorBlinking: o.smoothCaret ? 'smooth' : 'blink', lineNumbers: o.lineNumbers === false ? 'off' : 'on', renderWhitespace: o.whitespace ? 'all' : 'selection', stickyScroll: { enabled: o.sticky !== false } });
  if (o.theme) setEditorTheme(o.theme);
}
export const formatDocument = (editor) => editor.getAction('editor.action.formatDocument')?.run();
export const currentPosition = (editor) => { const p = editor.getPosition(); return p ? { line: p.lineNumber, column: p.column } : null; };
export const languageName = (path) => languageOf(path);

export function createEditor(host, { readOnly = false, theme = 'hackconnect' } = {}) {
  defineThemes();
  try { // the TypeScript API lives at monaco.typescript in newer releases and monaco.languages.typescript in older ones
    const ts = monaco.typescript || monaco.languages.typescript;
    for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
    ts.typescriptDefaults.setCompilerOptions({ jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2020, allowNonTsExtensions: true });
  } catch (error) { console.warn('TypeScript language options unavailable:', error.message); }
  const editor = monaco.editor.create(host, { model: null, theme, automaticLayout: true, minimap: { enabled: false }, fontSize: 13, lineHeight: 22, scrollBeyondLastLine: false, wordWrap: 'on', scrollbar: { alwaysConsumeMouseWheel: false, verticalScrollbarSize: 10, horizontalScrollbarSize: 10 }, padding: { top: 12 }, readOnly, tabSize: 2, renderWhitespace: 'selection', fixedOverflowWidgets: true, smoothScrolling: true, bracketPairColorization: { enabled: true }, guides: { bracketPairs: true } });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => window.dispatchEvent(new CustomEvent('hc:save')));
  return editor;
}

// ---- Markdown (sanitised) and ZIP reading for the project page and importer
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') { const href = node.getAttribute('href') || ''; if (/^(https?:|mailto:|#)/i.test(href)) { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); } else node.removeAttribute('href'); }
  if (node.tagName === 'IMG') { const src = node.getAttribute('src') || ''; if (!/^https:/i.test(src) && !/^data:image\/(png|jpe?g|gif|webp);/i.test(src)) node.remove(); else node.setAttribute('loading', 'lazy'); }
});
export function renderMarkdown(text) { return DOMPurify.sanitize(marked.parse(String(text || ''), { gfm: true, async: false }), { FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'link', 'meta'], FORBID_ATTR: ['style', 'srcset'] }); }
/** Read a .zip into [{ path, content }] text files. Binary and oversized entries are reported, not read. */
export function readZip(arrayBuffer, { maxBytes = 500000, maxEntries = 6000 } = {}) {
  const entries = unzipSync(new Uint8Array(arrayBuffer), { filter: (f) => !f.name.endsWith('/') && f.originalSize <= maxBytes * 4 }); const files = []; const skipped = [];
  for (const [path, data] of Object.entries(entries).slice(0, maxEntries)) { if (data.length > maxBytes) { skipped.push({ path, reason: `larger than ${maxBytes / 1000} KB` }); continue; } if (data.includes(0)) { skipped.push({ path, reason: 'binary file' }); continue; } files.push({ path, content: strFromU8(data) }); }
  return { files, skipped };
}

// Monaco providers (e.g. word completion) may still be answering for a model we just swapped out; dispose a little later.
const disposeLater = (model) => setTimeout(() => { if (!model.isDisposed()) model.dispose(); }, 3000);

/** Show a plain (unbound) model, for the moment before the first sync. Returns a dispose function. */
export function previewFile(editor, path, text, readOnly = true) {
  const model = monaco.editor.createModel(text, languageOf(path)); model.setEOL(monaco.editor.EndOfLineSequence.LF); editor.setModel(model); editor.updateOptions({ readOnly });
  return () => { if (editor.getModel() === model) editor.setModel(null); disposeLater(model); };
}

const styleEl = (() => { const el = document.createElement('style'); el.id = 'hc-remote-cursors'; document.head.appendChild(el); return el; })();
function paintRemoteCursors(conn) {
  const css = []; for (const [clientId, state] of conn.awareness.getStates()) {
    if (clientId === conn.doc.clientID || !state.user) continue; const color = String(state.user.color || '#7bd88f').replace(/[^#0-9a-fA-F]/g, ''); const name = String(state.user.name || 'Guest').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 24);
    css.push(`.yRemoteSelection-${clientId}{background:${color}40}.yRemoteSelectionHead-${clientId}{position:absolute;border-left:2px solid ${color};height:100%;box-sizing:border-box}.yRemoteSelectionHead-${clientId}::after{content:"${name}";position:absolute;top:-1.4em;left:-2px;background:${color};color:#101513;font:600 10px/1.4 system-ui;padding:0 4px;border-radius:3px;white-space:nowrap}`);
  }
  styleEl.textContent = css.join('\n');
}

/** Bind a Monaco editor to files[path] on a collab connection: live remote cursors, selections and names. */
export function bindEditor(editor, conn, path, { onChange = () => {} } = {}) {
  let ytext = conn.files.get(path); if (!ytext) { ytext = new Y.Text(); conn.files.set(path, ytext); }
  const model = monaco.editor.createModel(ytext.toString(), languageOf(path)); model.setEOL(monaco.editor.EndOfLineSequence.LF); editor.setModel(model);
  const binding = new MonacoBinding(ytext, model, new Set([editor]), conn.awareness);
  const report = () => { const pos = editor.getPosition(); conn.awareness.setLocalStateField('file', path); conn.awareness.setLocalStateField('line', pos ? pos.lineNumber : null); };
  const sub1 = editor.onDidChangeCursorPosition(report); const sub2 = model.onDidChangeContent(onChange); const onAware = () => paintRemoteCursors(conn); conn.awareness.on('change', onAware); paintRemoteCursors(conn); report();
  return () => { sub1.dispose(); sub2.dispose(); conn.awareness.off('change', onAware); binding.destroy(); if (editor.getModel() === model) editor.setModel(null); disposeLater(model); };
}
