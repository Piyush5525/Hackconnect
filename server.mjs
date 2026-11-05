import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './lib/app.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const envFile = join(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) process.env[match[1]] ||= match[2].replace(/^['"]|['"]$/g, '');
  }
}

const port = Number(process.env.PORT || 4173);
const app = createApp({ canonicalLocalhost: true, root, stateFile: join(root, '.hackconnect', 'state.json'), secureCookies: process.env.HACKCONNECT_SECURE_COOKIES === 'true' });
const { server } = app;
server.listen(port, () => console.log(`HackConnect running at http://localhost:${port}`));
// Flush pending writes on Ctrl+C / stop so nothing in the last 250 ms is lost.
let closing = false; for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (closing) return; closing = true; try { await app.close(); } finally { process.exit(0); } });
