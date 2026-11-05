// Copies the state file to a timestamped backup and prunes old ones.
//   node scripts/backup.mjs [backupDir] [keep=14]       (cron: 0 * * * *)
// Restore: stop the app, copy a backup over .hackconnect/state.json, start the app.
import { copyFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const state = join(root, '.hackconnect', 'state.json'); const dest = process.argv[2] || join(root, '.hackconnect', 'backups'); const keep = Number(process.argv[3] || 14);
if (!existsSync(state)) { console.error('No state file to back up'); process.exit(1); }
mkdirSync(dest, { recursive: true }); const name = `state-${new Date().toISOString().replace(/[:.]/g, '-')}.json`; copyFileSync(state, join(dest, name));
const all = readdirSync(dest).filter((f) => /^state-.*\.json$/.test(f)).sort(); for (const old of all.slice(0, Math.max(0, all.length - keep))) rmSync(join(dest, old));
console.log(`Backed up to ${join(dest, name)} (${Math.min(all.length, keep)} kept)`);
