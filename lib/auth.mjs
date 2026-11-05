import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const SESSION_COOKIE = 'hc_session';
export const SESSION_TTL_MS = 14 * 24 * 3600 * 1000;

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
export const newToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(actual, expected);
}

export function validateSignup({ name, email, password }) { // username is validated separately (needs the user list)
  const cleanName = String(name || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (cleanName.length < 1 || cleanName.length > 80) return { error: 'Name must be 1-80 characters' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || cleanEmail.length > 254) return { error: 'A valid email is required' };
  if (typeof password !== 'string' || password.length < 10 || password.length > 200) return { error: 'Password must be at least 10 characters' };
  return { name: cleanName, email: cleanEmail, password };
}

export const initialsOf = (name) => String(name).split(/\s+/).filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase() || '?';

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index > 0) out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

export function sessionCookie(token, { secure = false, maxAgeMs = SESSION_TTL_MS } = {}) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? '; Secure' : ''}`;
}

// Fixed-window in-memory rate limiter (single-process; swap for Redis when scaling out).
export function createRateLimiter({ limit, windowMs }) {
  const hits = new Map();
  return (key, now = Date.now()) => {
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      if (hits.size > 10000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}

/** True when the browser is talking to us over HTTPS (reverse proxy header, https base URL, or SECURE_COOKIES on a real host).
 *  Plain http://localhost never gets Secure cookies or https redirect URIs, even if SECURE_COOKIES=true was left on. */
export function makeIsHttps({ secureCookies = false } = {}) {
  const local = (host) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(String(host || ''));
  return (req) => {
    const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase(); if (forwarded) return forwarded === 'https';
    if (/^https:/i.test(process.env.HACKCONNECT_BASE_URL || '')) return true;
    return secureCookies && !local(req.headers.host);
  };
}
