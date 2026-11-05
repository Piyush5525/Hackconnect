// AES-256-GCM encryption for stored third-party tokens. Key: HACKCONNECT_MASTER_KEY (base64, 32 bytes) or a generated key file.
import crypto from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export function loadMasterKey(keyFile) {
  const fromEnv = process.env.HACKCONNECT_MASTER_KEY;
  if (fromEnv) { const key = Buffer.from(fromEnv, 'base64'); if (key.length !== 32) throw new Error('HACKCONNECT_MASTER_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)'); return key; }
  if (existsSync(keyFile)) return Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64');
  const key = crypto.randomBytes(32); mkdirSync(dirname(keyFile), { recursive: true }); writeFileSync(keyFile, key.toString('base64'), { mode: 0o600 });
  try { chmodSync(keyFile, 0o600); } catch { /* not supported on Windows */ } return key;
}

export function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${data.toString('base64')}`;
}

export function decrypt(key, payload) {
  const [version, iv, tag, data] = String(payload).split('.'); if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unsupported ciphertext');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64')); decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
