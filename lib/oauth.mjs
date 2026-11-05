// OAuth 2.0 authorization-code + PKCE for GitHub and Google (free). Used for sign-in, sign-up, and linking accounts.
import crypto from 'node:crypto';
import { initialsOf, newToken, sha256 } from './auth.mjs';
import { encrypt } from './crypto.mjs';
import { makeUsername } from './social.mjs';

const env = (name) => process.env[name] || '';
const PROVIDERS = {
  github: {
    label: 'GitHub', id: () => env('GITHUB_CLIENT_ID'), secret: () => env('GITHUB_CLIENT_SECRET'),
    authUrl: () => env('HACKCONNECT_OAUTH_GITHUB_AUTH_URL') || 'https://github.com/login/oauth/authorize',
    tokenUrl: () => env('HACKCONNECT_OAUTH_GITHUB_TOKEN_URL') || 'https://github.com/login/oauth/access_token',
    api: () => env('HACKCONNECT_GITHUB_API_URL') || 'https://api.github.com',
    scope: () => 'read:user user:email repo', // sign-in also grants repo access so the user's repositories can be listed and imported
    async profile(accessToken, api) {
      const headers = { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.github+json', 'user-agent': 'HackConnect', 'x-github-api-version': '2022-11-28' };
      const user = await getJson(`${api}/user`, headers); const emails = await getJson(`${api}/user/emails`, headers).catch(() => []);
      const primary = (Array.isArray(emails) ? emails : []).find((e) => e.primary && e.verified) || (Array.isArray(emails) ? emails : []).find((e) => e.verified);
      return { providerId: String(user.id), email: primary?.email?.toLowerCase() || '', emailVerified: Boolean(primary), name: user.name || user.login, handle: user.login };
    }
  },
  google: {
    label: 'Google', id: () => env('GOOGLE_CLIENT_ID'), secret: () => env('GOOGLE_CLIENT_SECRET'),
    authUrl: () => env('HACKCONNECT_OAUTH_GOOGLE_AUTH_URL') || 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: () => env('HACKCONNECT_OAUTH_GOOGLE_TOKEN_URL') || 'https://oauth2.googleapis.com/token',
    api: () => env('HACKCONNECT_OAUTH_GOOGLE_USERINFO_URL') || 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: () => 'openid email profile',
    async profile(accessToken, api) {
      const info = await getJson(api, { authorization: `Bearer ${accessToken}` });
      return { providerId: String(info.sub), email: String(info.email || '').toLowerCase(), emailVerified: info.email_verified === true || info.email_verified === 'true', name: info.name || String(info.email || '').split('@')[0], handle: info.email };
    }
  }
};
async function getJson(url, headers) { const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) }); if (!res.ok) throw new Error(`Provider request failed (${res.status})`); return res.json(); }
const enabled = (name) => Boolean(PROVIDERS[name]?.id() && PROVIDERS[name]?.secret());

export function createOAuth({ db, masterKey, audit, save, startSession, isHttps = () => false, port = 4173 }) {
  db.identities ||= []; const pending = new Map(); // state -> { provider, verifier, linkUserId, expires }
  const baseUrl = (req) => (process.env.HACKCONNECT_BASE_URL || `${isHttps(req) ? 'https' : 'http'}://${req.headers.host || `localhost:${port}`}`).replace(/\/+$/, '');
  const cookieName = 'hc_oauth';
  const redirect = (res, location, extra = []) => { res.writeHead(302, { location, 'cache-control': 'no-store', ...(extra.length ? { 'set-cookie': extra } : {}) }); res.end(); };
  const clearStateFor = (req) => `${cookieName}=; Path=/api/auth/oauth; HttpOnly; SameSite=Lax; Max-Age=0${isHttps(req) ? '; Secure' : ''}`;
  const fail = (res, message, req) => redirect(res, `/?auth_error=${encodeURIComponent(message)}`, [clearStateFor(req)]);

  const providers = () => ({ github: enabled('github'), google: enabled('google') });
  const identitiesOf = (user) => db.identities.filter((i) => i.userId === user.id).map((i) => ({ provider: i.provider, handle: i.handle, email: i.email, hasRepoAccess: Boolean(i.tokenEnc && i.scopes?.includes('repo')), linkedAt: i.createdAt }));

  /** Returns the user's own GitHub token (decrypted by the caller) if they linked it with repo access. */
  const githubTokenFor = (user, decrypt) => { const i = db.identities.find((x) => x.userId === user.id && x.provider === 'github' && x.tokenEnc && x.scopes?.includes('repo')); return i ? decrypt(i.tokenEnc) : null; };

  function start(req, res, provider, url, sessionUser) {
    if (!PROVIDERS[provider]) return fail(res, 'Unknown sign-in provider', req);
    if (!enabled(provider)) return fail(res, `${PROVIDERS[provider].label} sign-in is not configured on this server yet`, req);
    const link = url.searchParams.get('link') === '1'; if (link && !sessionUser) return fail(res, 'Sign in first, then connect your account', req);
    const state = newToken(24); const verifier = newToken(48); const p = PROVIDERS[provider];
    pending.set(state, { provider, verifier, linkUserId: link ? sessionUser.id : null, expires: Date.now() + 10 * 60000 }); for (const [k, v] of pending) if (v.expires < Date.now()) pending.delete(k);
    const auth = new URL(p.authUrl());
    auth.search = new URLSearchParams({ client_id: p.id(), redirect_uri: `${baseUrl(req)}/api/auth/oauth/${provider}/callback`, response_type: 'code', scope: p.scope(link), state, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', ...(provider === 'google' ? { access_type: 'online', prompt: 'select_account' } : {}) }).toString();
    redirect(res, auth.toString(), [`${cookieName}=${state}; Path=/api/auth/oauth; HttpOnly; SameSite=Lax; Max-Age=600${isHttps(req) ? '; Secure' : ''}`]);
  }

  async function callback(req, res, provider, url, sessionUser) {
    const p = PROVIDERS[provider]; if (!p || !enabled(provider)) return fail(res, 'Sign-in provider is not available', req);
    if (url.searchParams.get('error')) return fail(res, `${p.label} declined the request`, req);
    const state = url.searchParams.get('state') || ''; const cookie = /(?:^|;\s*)hc_oauth=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    const entry = pending.get(state); pending.delete(state);
    if (!entry || entry.provider !== provider || entry.expires < Date.now() || !cookie || cookie !== state) return fail(res, 'Sign-in expired or was tampered with. Please try again.', req);
    try {
      const tokenRes = await fetch(p.tokenUrl(), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: String(url.searchParams.get('code') || ''), redirect_uri: `${baseUrl(req)}/api/auth/oauth/${provider}/callback`, client_id: p.id(), client_secret: p.secret(), code_verifier: entry.verifier }).toString(), signal: AbortSignal.timeout(10000) });
      const tokens = await tokenRes.json().catch(() => ({})); if (!tokenRes.ok || !tokens.access_token) return fail(res, `${p.label} did not accept the sign-in. Please try again.`, req);
      const profile = await p.profile(tokens.access_token, p.api());
      const scopes = String(tokens.scope || '').split(/[ ,]+/).filter(Boolean); const tokenEnc = provider === 'github' && scopes.includes('repo') ? encrypt(masterKey, tokens.access_token) : null;
      let identity = db.identities.find((i) => i.provider === provider && i.providerId === profile.providerId);

      if (entry.linkUserId) { // connecting a provider to the signed-in account
        const me = db.users.find((u) => u.id === entry.linkUserId); if (!me || !sessionUser || sessionUser.id !== me.id) return fail(res, 'Your session changed. Sign in again and retry.', req);
        if (identity && identity.userId !== me.id) return fail(res, `That ${p.label} account is already connected to another HackConnect account`, req);
        if (!identity) { identity = { id: crypto.randomUUID(), userId: me.id, provider, providerId: profile.providerId, createdAt: Date.now() }; db.identities.push(identity); }
        Object.assign(identity, { handle: profile.handle, email: profile.email, scopes, ...(tokenEnc ? { tokenEnc } : {}) }); audit(me, 'oauth.link', me.id, provider); save();
        return redirect(res, `/?linked=${provider}`, [clearStateFor(req)]);
      }

      let user = identity && db.users.find((u) => u.id === identity.userId);
      if (!user) {
        if (!profile.email || !profile.emailVerified) return fail(res, `${p.label} did not share a verified email address, so we cannot create your account. Verify your email with ${p.label} and retry.`, req);
        user = db.users.find((u) => u.email === profile.email);
        if (user) { // same verified email as an existing account
          if (!user.emailVerified) { user.passwordHash = null; db.sessions = db.sessions.filter((s) => s.userId !== user.id); audit(user, 'oauth.takeover_guard', user.id, provider); } // an unverified password claim on this email is not trusted
          user.emailVerified = true;
        } else {
          user = { id: crypto.randomUUID(), username: makeUsername(db, profile.handle, profile.name, profile.email), name: String(profile.name || profile.email.split('@')[0]).slice(0, 80), initials: initialsOf(profile.name || profile.email), email: profile.email, passwordHash: null, emailVerified: true, role: db.users.length === 0 ? 'admin' : 'user', createdAt: Date.now() };
          db.users.push(user);
        }
        identity = { id: crypto.randomUUID(), userId: user.id, provider, providerId: profile.providerId, createdAt: Date.now() }; db.identities.push(identity);
      }
      if (user.suspended) return fail(res, 'This account is suspended', req);
      Object.assign(identity, { handle: profile.handle, email: profile.email, scopes, ...(tokenEnc ? { tokenEnc } : {}) });
      audit(user, 'oauth.login', user.id, provider); const headers = startSession(res, user, req); save();
      redirect(res, '/', [headers['set-cookie'], clearStateFor(req)]);
    } catch (error) { console.error('oauth callback failed:', error.message); fail(res, `Could not complete ${p.label} sign-in. Please try again.`, req); }
  }

  function unlink(user, provider) {
    const mine = db.identities.filter((i) => i.userId === user.id); const target = mine.find((i) => i.provider === provider); if (!target) return { status: 404, body: { error: 'That account is not connected' } };
    if (!user.passwordHash && mine.length < 2) return { status: 409, body: { error: 'This is your only way to sign in. Set a password or connect another account first.' } };
    db.identities = db.identities.filter((i) => i !== target); audit(user, 'oauth.unlink', user.id, provider); save(); return { status: 200, body: { ok: true } };
  }
  return { providers, identitiesOf, start, callback, unlink, githubTokenFor };
}
