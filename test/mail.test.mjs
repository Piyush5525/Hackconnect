import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../lib/app.mjs';
import { createMailer } from '../lib/mail.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const quiet = console.log; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const boot = async (dir) => { const app = createApp({ root, stateFile: join(dir, 's.json'), authLimit: 1e6, autoBackupMinutes: 0 }); await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); app.base = `http://127.0.0.1:${app.server.address().port}`; return app; };
const client = (app) => { let cookie = ''; return { get cookie() { return cookie; }, call: async (method, path, body) => { const res = await fetch(app.base + path, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const set = res.headers.get('set-cookie'); if (set && /hc_session=[^;]+/.test(set)) cookie = set.split(';')[0]; return { status: res.status, body: await res.json().catch(() => ({})) }; } }; };
const outbox = (dir) => { try { return readdirSync(join(dir, 'outbox')).sort().map((f) => readFileSync(join(dir, 'outbox', f), 'utf8')); } catch { return []; } };
const tokenFrom = (mail, key) => new RegExp(`\\?${key}=([A-Za-z0-9_-]+)`).exec(mail)[1];

test('local outbox mode: email verification and password reset end to end', async () => {
  console.log = () => {}; const dir = mkdtempSync(join(tmpdir(), 'hc-mail-')); const app = await boot(dir);
  try {
    const c = client(app); const su = await c.call('POST', '/api/auth/signup', { name: 'Mail Person', email: 'mp@example.com', password: 'correct-horse-battery' });
    assert.equal(su.status, 201); assert.equal(su.body.delivery, 'outbox'); assert.equal(su.body.needsVerification, false); assert.equal(su.body.user.emailVerified, false); assert.equal((await c.call('GET', '/api/auth/me')).status, 200, 'local dev: usable before verifying');
    const [verifyMail] = outbox(dir); assert.match(verifyMail, /^To: mp@example\.com/); const vtoken = tokenFrom(verifyMail, 'verify'); assert.ok(!JSON.stringify(su.body).includes(vtoken), 'token never returned by the API');
    assert.equal((await c.call('POST', '/api/auth/verify', { token: 'bogus' })).status, 400); assert.equal((await c.call('POST', '/api/auth/verify', { token: vtoken })).status, 200); assert.equal((await c.call('GET', '/api/auth/me')).body.user.emailVerified, true); assert.equal((await c.call('POST', '/api/auth/verify', { token: vtoken })).status, 400, 'one-time');
    // forgot password: same answer for unknown emails, and no mail is sent for them
    const before = outbox(dir).length; const unknown = await client(app).call('POST', '/api/auth/forgot', { email: 'nobody@example.com' }); assert.equal(unknown.status, 200); assert.equal(outbox(dir).length, before);
    const other = client(app); assert.equal((await other.call('POST', '/api/auth/forgot', { email: 'MP@example.com' })).status, 200); const mails = outbox(dir); assert.equal(mails.length, before + 1);
    const rtoken = tokenFrom(mails.at(-1), 'reset'); await other.call('POST', '/api/auth/forgot', { email: 'mp@example.com' }); assert.equal(outbox(dir).length, before + 1, 'throttled to one mail per minute');
    assert.equal((await other.call('POST', '/api/auth/reset', { token: rtoken, password: 'short' })).status, 400); assert.equal((await other.call('POST', '/api/auth/reset', { token: 'nope', password: 'brand-new-password-1' })).status, 400);
    for (let i = 0; i < 5; i++) await client(app).call('POST', '/api/auth/login', { email: 'mp@example.com', password: 'wrong-password-123' }); // lock the account
    assert.equal((await other.call('POST', '/api/auth/reset', { token: rtoken, password: 'brand-new-password-1' })).status, 200);
    assert.equal((await c.call('GET', '/api/auth/me')).status, 401, 'old session signed out'); assert.equal((await client(app).call('POST', '/api/auth/login', { email: 'mp@example.com', password: 'correct-horse-battery' })).status, 401, 'old password dead');
    assert.equal((await client(app).call('POST', '/api/auth/login', { email: 'mp@example.com', password: 'brand-new-password-1' })).status, 200, 'reset also clears the lockout');
    assert.equal((await other.call('POST', '/api/auth/reset', { token: rtoken, password: 'another-password-22' })).status, 400, 'reset link is single use');
    // expiry
    await client(app).call('POST', '/api/auth/forgot', { email: 'mp@example.com' }); app.db.users[0].reset.sentAt = 0; await client(app).call('POST', '/api/auth/forgot', { email: 'mp@example.com' }); const t2 = tokenFrom(outbox(dir).at(-1), 'reset'); app.db.users[0].reset.expires = Date.now() - 1; assert.equal((await client(app).call('POST', '/api/auth/reset', { token: t2, password: 'whatever-password-1' })).status, 400);
    // resend verification for an unverified account is throttled; verified accounts are a no-op
    const u2 = client(app); await u2.call('POST', '/api/auth/signup', { name: 'Second', email: 'second@example.com', password: 'correct-horse-battery' }); assert.equal((await u2.call('POST', '/api/auth/resend-verification', {})).status, 429); app.db.users[1].verify.sentAt = 0; assert.equal((await u2.call('POST', '/api/auth/resend-verification', {})).status, 200);
    assert.equal((await client(app).call('POST', '/api/auth/resend-verification', {})).status, 401);
  } finally { console.log = quiet; await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

// A tiny SMTP server that records the conversation.
const fakeSmtp = async () => {
  const seen = { commands: [], messages: [] };
  const server = net.createServer((socket) => {
    let data = ''; let inData = false; let authStep = 0; socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      data += chunk;
      for (;;) {
        if (inData) { const end = data.indexOf('\r\n.\r\n'); if (end < 0) return; seen.messages.push(data.slice(0, end)); data = data.slice(end + 5); inData = false; socket.write('250 queued\r\n'); continue; }
        const eol = data.indexOf('\r\n'); if (eol < 0) return; const line = data.slice(0, eol); data = data.slice(eol + 2); seen.commands.push(line);
        if (authStep === 1) { authStep = 2; socket.write('334 UGFzc3dvcmQ6\r\n'); } else if (authStep === 2) { authStep = 0; socket.write('235 ok\r\n'); }
        else if (/^EHLO/.test(line)) socket.write('250-fake\r\n250 AUTH LOGIN\r\n');
        else if (line === 'AUTH LOGIN') { authStep = 1; socket.write('334 VXNlcm5hbWU6\r\n'); }
        else if (/^MAIL|^RCPT/.test(line)) socket.write('250 ok\r\n');
        else if (line === 'DATA') { socket.write('354 go\r\n'); inData = true; }
        else if (line === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); return { seen, port: server.address().port, close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }) };
};

test('SMTP mode: sends authenticated mail, blocks header injection, and enforces verified email', async () => {
  const smtp = await fakeSmtp(); const keys = { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_TLS: 'off', SMTP_USER: 'mailer', SMTP_PASS: 'p@ss', SMTP_FROM: 'HackConnect <hello@example.com>' }; Object.assign(process.env, keys);
  const dir = mkdtempSync(join(tmpdir(), 'hc-mail-')); const app = await boot(dir); console.log = () => {};
  try {
    const direct = createMailer({ outboxDir: dir }); assert.equal(direct.mode, 'smtp');
    await direct.send({ to: 'a@example.com\r\nBcc: evil@example.com', subject: 'Hi\r\nBcc: evil2@example.com', text: 'line one\n.dot line\nbye' });
    assert.ok(smtp.seen.commands.includes(Buffer.from('mailer').toString('base64')), 'AUTH LOGIN username sent'); assert.ok(smtp.seen.commands.includes(Buffer.from('p@ss').toString('base64')), 'AUTH LOGIN password sent');
    const msg = smtp.seen.messages.at(-1); assert.ok(!/^Bcc:/mi.test(msg), 'no injected header lines'); assert.match(msg, /\r\n\.\.dot line/, 'dot-stuffing');
    // verification is required once real email can be sent
    const c = client(app); const su = await c.call('POST', '/api/auth/signup', { name: 'Smtp User', email: 'smtp@example.com', password: 'correct-horse-battery' });
    assert.equal(su.status, 201); assert.equal(su.body.needsVerification, true); assert.equal(c.cookie, '', 'no session before verification'); assert.equal((await c.call('GET', '/api/auth/me')).status, 401);
    const login = await c.call('POST', '/api/auth/login', { email: 'smtp@example.com', password: 'correct-horse-battery' }); assert.equal(login.status, 403); assert.equal(login.body.needsVerification, true);
    await sleep(100); const link = smtp.seen.messages.find((m) => /smtp@example\.com/.test(m) && /verify=/.test(m)); assert.ok(link, 'verification email delivered over SMTP'); const token = tokenFrom(link, 'verify');
    assert.equal((await c.call('POST', '/api/auth/verify', { token })).status, 200); assert.equal((await c.call('POST', '/api/auth/login', { email: 'smtp@example.com', password: 'correct-horse-battery' })).status, 200);
  } finally { console.log = quiet; for (const k of Object.keys(keys)) delete process.env[k]; await app.close(); await smtp.close(); rmSync(dir, { recursive: true, force: true }); }
});
