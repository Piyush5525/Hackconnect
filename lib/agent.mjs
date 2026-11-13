// Built-in AI assistant: provider adapters (Anthropic, OpenAI-compatible: Ollama / Groq / Gemini / OpenRouter / OpenAI) + a keyless demo mode.
import dns from 'node:dns/promises';
import net from 'node:net';

export const PRESETS = [
  { id: 'demo', label: 'Demo mode (no AI, free)', needsKey: false },
  { id: 'ollama', label: 'Ollama (free, runs on your computer)', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder', needsKey: false },
  { id: 'groq', label: 'Groq (free tier)', baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', needsKey: true, budget: 16000 },
  { id: 'gemini', label: 'Google Gemini (free tier)', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-flash-latest', needsKey: true },
  { id: 'openrouter', label: 'OpenRouter (free models)', baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free', needsKey: true },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', needsKey: true },
  { id: 'deepseek', label: 'DeepSeek (cheap, strong at code)', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', needsKey: true },
  { id: 'mistral', label: 'Mistral (Codestral)', baseUrl: 'https://api.mistral.ai/v1', model: 'codestral-latest', needsKey: true },
  { id: 'xai', label: 'xAI (Grok)', baseUrl: 'https://api.x.ai/v1', model: 'grok-code-fast-1', needsKey: true },
  { id: 'anthropic', label: 'Anthropic (Claude)', model: 'claude-sonnet-5-5', needsKey: true },
  { id: 'local-claude', label: 'Claude: sign in (uses Claude Code on your computer)', local: 'claude', needsKey: false },
  { id: 'local-codex', label: 'Codex / ChatGPT: sign in (uses Codex CLI on your computer)', local: 'codex', needsKey: false },
  { id: 'custom', label: 'Other OpenAI-compatible server', baseUrl: '', model: '', needsKey: false }
];

// ---- SSRF guard: a user-supplied endpoint must never reach cloud metadata, and only reaches private networks when allowed.
const isPrivateV4 = (ip) => { const [a, b] = ip.split('.').map(Number); return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127); };
const isLinkLocalV4 = (ip) => ip.startsWith('169.254.');
function classify(ip) {
  if (net.isIPv4(ip)) return { linkLocal: isLinkLocalV4(ip), isPrivate: isPrivateV4(ip) };
  const v = ip.toLowerCase();
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v); if (dotted) return classify(dotted[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v); // URL() normalises IPv4-mapped IPv6 to this form
  if (hex) { const hi = parseInt(hex[1], 16); const lo = parseInt(hex[2], 16); return classify(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`); }
  return { linkLocal: v.startsWith('fe80'), isPrivate: v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') };
}
export async function assertSafeAiUrl(raw, allowPrivate) {
  let url; try { url = new URL(raw); } catch { throw new Error('Enter a valid http(s) address for the AI server'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The AI server address must start with http:// or https://');
  if (url.username || url.password) throw new Error('Do not put a username or password in the address');
  const addresses = net.isIP(url.hostname.replace(/^\[|\]$/g, '')) ? [{ address: url.hostname.replace(/^\[|\]$/g, '') }] : await dns.lookup(url.hostname, { all: true }).catch(() => { throw new Error(`Cannot find the host "${url.hostname}"`); });
  for (const { address } of addresses) { const c = classify(address); if (c.linkLocal) throw new Error('That address is not allowed (link-local / cloud metadata range)'); if (c.isPrivate && !allowPrivate) throw new Error('This server only allows public AI endpoints. Local addresses (like Ollama on localhost) work when you run HackConnect on your own computer.'); }
  return url;
}

const SYSTEM = 'You are a careful coding assistant inside HackConnect, working in a shared team workspace. Reply with JSON only: {"message":"your answer in Markdown","changes":[{"path":"relative/file","content":"COMPLETE new file content"}]}. If the user only asks a question or wants an explanation, return "changes": []. Only change files that exist in the provided context or are clearly new; never use absolute paths or "..", never include secrets, prefer small safe edits, and explain what you changed in "message".';

// Files that tell a model nothing useful and only eat its context window.
const NOISE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|composer\.lock)$|\.min\.(js|css)$|\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|eot|mp[34]|map|lock|bin)$/i;
const DEFAULT_BUDGET = 60_000; const MIN_BUDGET = 3_000;
/**
 * Pick what the model gets to read, within a character budget: the open file first, then the README and the manifest,
 * then the smallest files. The open file / README are cut short rather than dropped; cut files are reported in
 * `truncated` so their (incomplete) content is never written back.
 */
export function selectContext(prompt, files, focus, budget = DEFAULT_BUDGET) {
  const rank = (path) => (path === focus ? 0 : /(^|\/)readme(\.[a-z]+)?$/i.test(path) ? 1 : /(^|\/)(package\.json|pyproject\.toml|requirements\.txt|go\.mod|Cargo\.toml|pom\.xml)$/i.test(path) ? 2 : 3);
  const order = Object.entries(files).filter(([, content]) => typeof content === 'string').sort(([a, ca], [b, cb]) => rank(a) - rank(b) || ca.length - cb.length || a.localeCompare(b));
  let used = 0; const included = {}; const omitted = []; const truncated = [];
  for (const [path, content] of order) {
    const left = budget - used;
    if (NOISE.test(path) && path !== focus) omitted.push(path);
    else if (content.length <= left) { included[path] = content; used += content.length; }
    else if (rank(path) < 3 && left > 1500) { included[path] = `${content.slice(0, left - 200)}\n[... file cut short to fit the model ...]`; truncated.push(path); used = budget; }
    else omitted.push(path);
  }
  const note = truncated.length || omitted.length ? `Not everything fits. ${truncated.length ? `These files are cut short, so never return changes for them: ${truncated.join(', ')}. ` : ''}Files in otherFiles were left out: if you need one, ask the user to open it.` : undefined;
  return { text: JSON.stringify({ request: prompt, openFile: focus || null, files: included, otherFiles: omitted.slice(0, 400), note }), truncated, included: Object.keys(included).length, omitted: omitted.length };
}
const buildContext = (prompt, files, focus, budget) => selectContext(prompt, files, focus, budget).text;
export function parseAgent(text) {
  const start = text.indexOf('{'); const end = text.lastIndexOf('}'); if (start < 0 || end < start) return { message: String(text).trim().slice(0, 8000) || 'The model returned an empty answer.', changes: [] }; // plain-text answer
  try { const result = JSON.parse(text.slice(start, end + 1)); return { message: String(result.message || 'Done.'), changes: Array.isArray(result.changes) ? result.changes : [] }; } catch { return { message: String(text).trim().slice(0, 8000), changes: [] }; }
}

/** One plain-text prompt for CLI tools that run on the user's own computer (Claude Code / Codex): system rules + recent turns + workspace context. */
export function buildLocalPrompt(prompt, files, { history = [], focus = null } = {}) {
  const turns = (Array.isArray(history) ? history : []).slice(-8).filter((m) => ['user', 'assistant'].includes(m?.role) && typeof m.content === 'string').map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 2000)}`).join('\n\n');
  return `${SYSTEM}\n\nDo not use any tools and do not read or write files yourself; answer only with the JSON described above.\n\n${turns ? `Conversation so far:\n${turns}\n\n` : ''}Workspace and request (JSON):\n${buildContext(prompt, files, focus)}`;
}

function demo(prompt, files) {
  const wantsEmptyState = /empty state|no activity|nothing yet/i.test(prompt); const path = Object.keys(files).find((file) => /dashboard\.(tsx|jsx|js)$/.test(file));
  if (wantsEmptyState && path) { const content = files[path].replace('  return (', '  const hasActivity = project.activity?.length > 0\n\n  return (').replace('<ActivityFeed projectId={project.id} />', '<ActivityFeed projectId={project.id} empty={!hasActivity} />'); return { provider: 'demo', message: 'I added a small activity guard and passed an empty-state flag to `ActivityFeed`. Review the diff before applying it.', changes: [{ path, content }] }; }
  return { provider: 'demo', message: `I can see **${Object.keys(files).length} files** in this workspace.\n\nThis is **demo mode**, so I cannot really write code yet. Click the gear in this panel and connect a free model (Ollama runs on your computer; Groq and Gemini have free tiers) to get real answers and edits.\n\nYou asked: _${prompt.trim().slice(0, 200) || 'describe what you want to build'}_`, changes: [] };
}

/** config: { provider, model, baseUrl, apiKey } from the user's settings (or null to use the server environment). */
export async function agentRequest(prompt, files, { config = null, history = [], focus = null, allowPrivate = false } = {}) {
  const env = process.env; let provider; let model; let baseUrl; let apiKey;
  if (config && config.provider && config.provider !== 'demo') ({ provider, model, baseUrl, apiKey } = config);
  else if (!config?.provider) { // fall back to the server-wide setting
    const p = (env.HACKCONNECT_AGENT_PROVIDER || 'demo').toLowerCase(); provider = p; model = env.HACKCONNECT_AGENT_MODEL; baseUrl = env.HACKCONNECT_AGENT_BASE_URL; apiKey = p === 'anthropic' ? env.ANTHROPIC_API_KEY : p === 'openai' ? env.OPENAI_API_KEY : p === 'groq' ? (env.GROQ_API_KEY || env.GROQ_API) : p === 'gemini' ? (env.GEMINI_API_KEY || env.GEMINI_API) : p === 'openrouter' ? (env.OPENROUTER_API_KEY || env.OPENROUTER_API) : env.HACKCONNECT_AGENT_API_KEY;
    if (p === 'openai') baseUrl = 'https://api.openai.com/v1'; if (p === 'compatible') provider = 'custom';
    if (['groq', 'gemini', 'openrouter'].includes(p)) { baseUrl = undefined; if (/^gpt-/i.test(model || '')) model = undefined; } // free hosted presets: use the preset's address and default model
    if (p === 'demo' || (['anthropic', 'openai', 'groq', 'gemini', 'openrouter'].includes(p) && !apiKey) || (p === 'custom' && !baseUrl)) return demo(prompt, files);
  } else return demo(prompt, files);
  if (String(provider).startsWith('local-')) throw new Error('This assistant runs on your own computer. Start the HackConnect assistant bridge and try again.');
  const preset = PRESETS.find((x) => x.id === provider); let budget = preset?.budget || DEFAULT_BUDGET; let picked = selectContext(prompt, files, focus, budget); let context = picked.text;
  // A partial file must never be written back as if it were the whole file.
  const finish = (label, text) => { const result = parseAgent(text); const blocked = result.changes.filter((c) => picked.truncated.includes(String(c?.path || ''))); if (blocked.length) { result.changes = result.changes.filter((c) => !blocked.includes(c)); result.message += `\n\n_I could only read part of ${blocked.map((c) => `\`${c.path}\``).join(', ')}, so I did not change ${blocked.length > 1 ? 'them' : 'it'}. Open the file and ask again._`; } if (picked.omitted || picked.truncated.length) result.message += `\n\n_Read ${picked.included} of ${picked.included + picked.omitted} files to fit ${label}'s limit${focus ? ', starting with the open file' : ''}._`; return { provider: label, ...result, context: { files: picked.included, leftOut: picked.omitted, cutShort: picked.truncated.length } }; };
  const turns = (Array.isArray(history) ? history : []).slice(-8).filter((m) => ['user', 'assistant'].includes(m?.role) && typeof m.content === 'string').map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
  const label = preset?.label?.split(' (')[0] || provider;
  if (provider === 'anthropic') {
    if (!apiKey) throw new Error('Add your Anthropic API key in the assistant settings (gear icon).');
    const response = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: model || preset.model, max_tokens: 8000, system: SYSTEM, messages: [...turns, { role: 'user', content: context }] }), signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(response.status === 401 ? 'Anthropic rejected the API key. Check it in the assistant settings.' : `Anthropic request failed (${response.status})`);
    const body = await response.json(); return finish(label, body.content?.map((part) => part.text || '').join('') || '');
  }
  const root = (baseUrl || preset?.baseUrl || '').replace(/\/+$/, ''); if (!root) throw new Error('Add the AI server address in the assistant settings (gear icon).');
  await assertSafeAiUrl(root, allowPrivate);
  const send = () => fetch(`${root}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify({ model: model || preset?.model || 'llama3.1', temperature: 0.2, messages: [{ role: 'system', content: SYSTEM }, ...turns, { role: 'user', content: context }] }), signal: AbortSignal.timeout(120000) });
  let response = await send();
  // "Too large" (413): free tiers cap how much one request may carry. Send less of the project and try again.
  while (response.status === 413 && budget > MIN_BUDGET) { budget = Math.max(MIN_BUDGET, Math.floor(budget / 2)); picked = selectContext(prompt, files, focus, budget); context = picked.text; response = await send(); }
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? `${label} rejected the API key. Check it in the assistant settings.` : response.status === 404 ? `${label} does not know the model "${model || preset?.model}". Check the model name in settings.` : response.status === 429 ? `${label} is rate limiting you. Wait a moment and try again.` : response.status === 413 ? `This request is too large for ${label}, even with only the open file. Ask about a smaller file, or pick a model with a bigger limit in the assistant settings.` : `${label} request failed (${response.status}). Is the server running?`);
  const body = await response.json(); return finish(label, body.choices?.[0]?.message?.content || '');
}
