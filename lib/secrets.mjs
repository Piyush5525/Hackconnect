// Shared secrets scanner + path rules used by the server and the Local Bridge.
const RULES = [
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['OpenAI-style key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['Stripe live key', /\b[sr]k_live_[A-Za-z0-9]{20,}\b/],
  ['Private key block', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ['Generic secret assignment', /\b(?:api[_-]?key|secret|password|passwd|token)\b["']?\s*[:=]\s*["'][A-Za-z0-9/+_\-=]{20,}["']/i]
];

/** Returns the names of rules that matched (never the secret itself). */
export function scanSecrets(text) {
  if (typeof text !== 'string' || text.length > 2_000_000) return [];
  return RULES.filter(([, re]) => re.test(text)).map(([name]) => name);
}

const SENSITIVE_NAME = [/(^|\/)\.env(\..*)?$/i, /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, /\.(pem|key|p12|pfx|jks|keystore)$/i, /(^|\/)\.(npmrc|pypirc|netrc|aws\/credentials)$/i, /(^|\/)credentials\.json$/i];
const ALWAYS_SKIP = [/(^|\/)node_modules(\/|$)/, /(^|\/)\.git(\/|$)/, /(^|\/)\.hackconnect(\/|$)/, /(^|\/)(dist|build|\.next|__pycache__|\.venv|venv)(\/|$)/, /\.(png|jpe?g|gif|ico|pdf|zip|gz|tar|exe|dll|so|dylib|woff2?|ttf|mp4|mov|bin)$/i];

export const isSensitivePath = (path) => SENSITIVE_NAME.some((re) => re.test(path.replaceAll('\\', '/')));
export const isAlwaysSkipped = (path) => ALWAYS_SKIP.some((re) => re.test(path.replaceAll('\\', '/')));

/** Compile .gitignore-style patterns to a matcher (supports *, **, ?, trailing /, leading /, ! negation). */
export function compileIgnore(source) {
  const rules = String(source || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((line) => {
    const negate = line.startsWith('!'); let p = negate ? line.slice(1) : line; const dirOnly = p.endsWith('/'); p = p.replace(/\/$/, '');
    const anchored = p.startsWith('/') || p.includes('/'); p = p.replace(/^\//, '');
    const body = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0001/g, '(?:.*/)?').replace(/\u0002/g, '.*');
    const re = new RegExp(`${anchored ? '^' : '(?:^|/)'}${body}${dirOnly ? '(?:/|$)' : '(?:$|/)'}`);
    return { negate, re };
  });
  return (path) => { let ignored = false; const norm = path.replaceAll('\\', '/'); for (const r of rules) if (r.re.test(norm)) ignored = !r.negate; return ignored; };
}
