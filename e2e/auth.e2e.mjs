// Auth UI in a real browser: friendly errors, email sign-up, Google/GitHub sign-in through a fake provider, Connections panel.
import http from 'node:http';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createApp } from '../lib/app.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)); const dir = mkdtempSync(join(tmpdir(), 'hc-e2e-auth-'));
const challenges = new Map(); const accounts = { gh: { id: 'gh-1', login: 'octo', name: 'Octo Cat', email: 'octo@example.com' }, g: { id: 'g-1', email: 'gina@example.com', name: 'Gina Google' } };
// Fake identity provider: /authorize immediately "approves" and sends the browser back with a code.
const idp = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); let body = ''; for await (const c of req) body += c; const json = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url.pathname === '/authorize') { const state = url.searchParams.get('state'); challenges.set(state, url.searchParams.get('client_id')); res.writeHead(302, { location: `${url.searchParams.get('redirect_uri')}?code=${state}&state=${state}` }); return res.end(); }
  if (url.pathname === '/token') return json({ access_token: `tok:${new URLSearchParams(body).get('code')}`, scope: 'read:user,user:email' });
  const who = challenges.get(String(req.headers.authorization || '').replace('Bearer tok:', '')) === 'gh-id' ? accounts.gh : accounts.g;
  if (url.pathname === '/user') return json({ id: who.id, login: who.login, name: who.name });
  if (url.pathname === '/user/emails') return json([{ email: who.email, primary: true, verified: true }]);
  if (url.pathname === '/userinfo') return json({ sub: who.id, email: who.email, email_verified: true, name: who.name });
  json({}, 404);
});
await new Promise((r) => idp.listen(0, '127.0.0.1', r)); const idpBase = `http://127.0.0.1:${idp.address().port}`;
Object.assign(process.env, { GITHUB_CLIENT_ID: 'gh-id', GITHUB_CLIENT_SECRET: 's', GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 's', HACKCONNECT_OAUTH_GITHUB_AUTH_URL: `${idpBase}/authorize`, HACKCONNECT_OAUTH_GITHUB_TOKEN_URL: `${idpBase}/token`, HACKCONNECT_GITHUB_API_URL: idpBase, HACKCONNECT_OAUTH_GOOGLE_AUTH_URL: `${idpBase}/authorize`, HACKCONNECT_OAUTH_GOOGLE_TOKEN_URL: `${idpBase}/token`, HACKCONNECT_OAUTH_GOOGLE_USERINFO_URL: `${idpBase}/userinfo` });
const app = createApp({ root, stateFile: join(dir, 's.json'), authLimit: 1000 }); await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${app.server.address().port}`;
const realLog = console.log; const browser = await chromium.launch(); const step = (m) => console.log(`  ✓ ${m}`);
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await new Promise((r) => setTimeout(r, 60)); } throw new Error(`timed out: ${fn}`); };
const newPage = async () => { const p = await (await browser.newContext()).newPage(); p.errors = []; p.on('pageerror', (e) => p.errors.push(e.message)); return p; };

try {
  const a = await newPage(); await a.goto(base); await a.waitForSelector('#authGate');
  assert.equal(await a.isVisible('#authName'), false); assert.equal(await a.isVisible('text=Name'), false); step('sign-in form does not show a stray "Name" label');
  assert.ok((await a.textContent('#authProviders')).includes('Continue with Google') && (await a.textContent('#authProviders')).includes('Continue with GitHub')); step('Google and GitHub buttons are shown');

  // the old "Failed to fetch" situation: the server cannot be reached
  await a.route('**/api/auth/login', (r) => r.abort()); await a.fill('#authEmail', 'x@example.com'); await a.fill('#authPassword', 'correct-horse-battery'); await a.click('#authSubmit');
  await until(async () => (await a.textContent('#authError')).includes('Cannot reach the HackConnect server')); assert.ok(!(await a.textContent('#authError')).includes('Failed to fetch')); step('unreachable server shows an actionable message, not "Failed to fetch"');
  await a.unroute('**/api/auth/login');

  // wrong password message
  await a.click('#authSubmit'); await until(async () => (await a.textContent('#authError')).includes('Invalid email or password')); step('wrong credentials show a clear error');

  // the built-in connection check explains what is reachable
  await a.click('#authDiag'); await until(async () => (await a.textContent('#authDiagOut')).includes('The browser can reach the server')); const report = await a.textContent('#authDiagOut'); assert.ok(report.includes('GET /health') && report.includes('HTTP 200') && report.includes('Google sign-in configured: true')); assert.ok(report.includes('POST /api/auth/login') && report.includes('HTTP 401')); step('connection check reports each step (health, options, sign-in request)');
  await a.route('**/api/auth/login', (r) => r.abort()); await a.click('#authSubmit'); await until(async () => (await a.textContent('#authDiagOut')).includes('FAIL')); assert.ok((await a.textContent('#authDiagOut')).includes('never reached the server')); await a.unroute('**/api/auth/login'); step('a blocked request automatically runs the check and explains the cause');
  // sign in with GitHub end to end
  await a.click('a:has-text("Continue with GitHub")'); await a.waitForSelector('#authGate', { state: 'detached' }); await until(async () => (await a.textContent('#profileBtn')) === 'OC'); step('Continue with GitHub signs in through the provider');
  await a.click('#connectionsBtn'); await a.waitForSelector('#connectionsDialog'); assert.ok((await a.textContent('#connectionsDialog')).includes('connected as octo')); assert.ok((await a.textContent('#connectionsDialog')).includes('no password set')); step('Connections panel shows GitHub linked and that there is no password');
  await a.click('#connectionsDialog >> text=Disconnect').catch(() => {}); // the only login method: server must refuse
  await until(async () => (await a.textContent('#toast')).includes('only way to sign in')); step('cannot disconnect the only login method');
  await a.keyboard.press('Escape'); await a.waitForSelector('#connectionsDialog', { state: 'detached' });

  // Google sign-in in a fresh browser, plus error return from a declined login
  const g = await newPage(); await g.goto(base); await g.waitForSelector('#authGate'); await g.click('a:has-text("Continue with Google")'); await g.waitForSelector('#authGate', { state: 'detached' }); await until(async () => (await g.textContent('#profileBtn')) === 'GG'); step('Continue with Google signs in');
  const d = await newPage(); await d.goto(`${base}/?auth_error=${encodeURIComponent('Google declined the request')}`); await d.waitForSelector('#authGate'); assert.ok((await d.textContent('#authError')).includes('Google declined')); step('provider errors are shown on the sign-in screen');

  // email sign-up still works and the second user can link GitHub
  const e = await newPage(); await e.goto(base); await e.waitForSelector('#authGate'); await e.click('#authToggle'); await e.fill('#authName', 'Em Mail'); await e.fill('#authEmail', 'em@example.com'); await e.fill('#authPassword', 'correct-horse-battery'); await e.click('#authSubmit'); await e.waitForSelector('#authGate', { state: 'detached' }); step('email sign-up works');
  await e.click('#connectionsBtn'); await e.waitForSelector('#connectionsDialog'); await e.click('#connectionsDialog >> a:has-text("Connect")'); await e.waitForSelector('#connectionsBtn'); await until(async () => (await e.textContent('#toast')).includes('already connected') || (await e.textContent('#toast')).includes('GitHub connected')); step('linking flow returns to the app with a message');

  // unverified banner, confirm-by-link, forgot password and reset through the UI
  assert.ok(await e.isVisible('#verifyBanner')); step('unverified accounts see a "confirm your email" banner');
  const outboxMails = () => readdirSync(join(dir, 'outbox')).sort().map((f) => readFileSync(join(dir, 'outbox', f), 'utf8'));
  const tokenOf = (mail, key) => new RegExp(`[?]${key}=([A-Za-z0-9_-]+)`).exec(mail)[1];
  const verifyToken = tokenOf(outboxMails().find((m) => m.includes('em@example.com') && m.includes('verify=')), 'verify');
  await e.goto(`${base}/?verify=${verifyToken}`); await until(async () => (await e.textContent('#toast')).includes('Email confirmed')); await e.waitForSelector('#verifyBanner', { state: 'detached' }); step('confirmation link marks the email as verified and removes the banner');
  const f = await newPage(); await f.goto(base); await f.waitForSelector('#authGate'); f.on('dialog', (d) => d.accept('em@example.com')); await f.click('#authForgot');
  await until(async () => (await f.textContent('#authError')).includes('reset link is on its way')); assert.ok((await f.textContent('#authError')).includes('.hackconnect/outbox')); step('"Forgot your password?" asks for the email and explains where the local link went');
  const resetToken = tokenOf(outboxMails().findLast((m) => m.includes('reset=')), 'reset');
  await f.goto(`${base}/?reset=${resetToken}`); await f.waitForSelector('#resetDialog'); await f.fill('#resetPassword', 'a-brand-new-password-9'); await f.click('#resetDialog button'); await f.waitForSelector('#resetDialog', { state: 'detached' }); step('reset page accepts a new password');
  await f.fill('#authEmail', 'em@example.com'); await f.fill('#authPassword', 'a-brand-new-password-9'); await f.click('#authSubmit'); await f.waitForSelector('#authGate', { state: 'detached' }); await until(async () => (await f.textContent('#profileBtn')) === 'EM'); step('can sign in with the new password');
  assert.deepEqual(f.errors, []);
  for (const p of [a, g, e]) assert.deepEqual(p.errors, []); step('no uncaught browser errors');
  console.log('\nAuth e2e PASSED');
} catch (error) { console.error('\nAuth e2e FAILED:', error.message); process.exitCode = 1; }
finally { await browser.close(); await app.close(); idp.closeAllConnections?.(); await new Promise((r) => idp.close(r)); rmSync(dir, { recursive: true, force: true }); }
