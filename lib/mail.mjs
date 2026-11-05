// Outgoing email. SMTP (any free provider: Gmail app password, Brevo, Mailpit...) or, with no SMTP configured, a local outbox
// folder + console line so local development works without any account.
import net from 'node:net';
import tls from 'node:tls';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const clean = (v) => String(v).replace(/[\r\n]+/g, ' ').trim(); // header-injection defence

function smtpSend({ host, port, secure, startTls, user, pass, from }, { to, subject, text }) {
  return new Promise((resolve, reject) => {
    let socket = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port }); let buffer = ''; let step = 'greet'; let upgraded = secure; let done = false;
    const finish = (error) => { if (done) return; done = true; clearTimeout(timer); try { socket.end(); } catch { /* ignore */ } error ? reject(error) : resolve(); };
    const timer = setTimeout(() => finish(new Error('SMTP timeout')), 20000);
    const write = (line) => socket.write(`${line}\r\n`);
    const queue = []; const message = `From: ${clean(from)}\r\nTo: ${clean(to)}\r\nSubject: ${clean(subject)}\r\nDate: ${new Date().toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${String(text).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')}\r\n.`;
    const plan = () => { const steps = []; steps.push(['EHLO hackconnect', 250]); if (!upgraded && startTls) steps.push(['STARTTLS', 220, 'tls']); if (user) { steps.push(['AUTH LOGIN', 334], [Buffer.from(user).toString('base64'), 334], [Buffer.from(pass || '').toString('base64'), 235]); } steps.push([`MAIL FROM:<${clean(from).replace(/^.*<|>.*$/g, '')}>`, 250], [`RCPT TO:<${clean(to)}>`, 250], ['DATA', 354], [message, 250], ['QUIT', 221]); return steps; };
    let steps = null; let index = 0;
    const next = () => { const [line, , action] = steps[index]; if (action === 'tls') { write(line); return; } write(line); };
    const onReply = (code) => {
      if (step === 'greet') { if (code !== 220) return finish(new Error(`SMTP greeting ${code}`)); step = 'run'; steps = plan(); index = 0; return next(); }
      const [, expected, action] = steps[index];
      if (code !== expected) return finish(new Error(`SMTP ${code} (expected ${expected}) at step ${index + 1}`));
      if (action === 'tls') { socket.removeAllListeners('data'); const secured = tls.connect({ socket, servername: host }, () => { socket = secured; upgraded = true; socket.on('data', onData); steps = plan().filter((s) => s[2] !== 'tls'); index = 0; next(); }); secured.on('error', finish); return; }
      index++; if (index >= steps.length) return finish(); next();
    };
    const onData = (chunk) => { buffer += chunk.toString('utf8'); let m; while ((m = /^(\d{3})([ -])[^\r\n]*\r\n/.exec(buffer))) { const multi = m[2] === '-'; buffer = buffer.slice(m[0].length); if (!multi) onReply(Number(m[1])); } };
    socket.on('data', onData); socket.on('error', finish); socket.on('close', () => finish());
    void queue;
  });
}

export function createMailer({ outboxDir, env = process.env, log = console.log } = {}) {
  const host = env.SMTP_HOST; const from = env.SMTP_FROM || 'HackConnect <no-reply@localhost>';
  if (host) {
    const secure = env.SMTP_SECURE === 'true'; const cfg = { host, port: Number(env.SMTP_PORT || (secure ? 465 : 587)), secure, startTls: !secure && env.SMTP_TLS !== 'off', user: env.SMTP_USER || '', pass: env.SMTP_PASS || '', from };
    return { mode: 'smtp', async send(mail) { await smtpSend(cfg, mail); } };
  }
  return {
    mode: 'outbox',
    async send({ to, subject, text }) {
      mkdirSync(outboxDir, { recursive: true }); const file = join(outboxDir, `${Date.now()}-${clean(to).replace(/[^a-z0-9@._-]/gi, '_')}.txt`);
      writeFileSync(file, `To: ${clean(to)}\nSubject: ${clean(subject)}\n\n${text}\n`); log(`[mail] No SMTP server configured. To: ${clean(to)} | ${clean(subject)}\n${text}\n(saved to ${file})`);
    }
  };
}
