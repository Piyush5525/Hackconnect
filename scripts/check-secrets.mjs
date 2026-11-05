// Fails if a real-looking secret is present in files that get committed or published (templates, docs, config, source).
//   node scripts/check-secrets.mjs        (also run by `npm test` and CI)
// Tests and e2e fixtures are excluded because they intentionally contain fake keys to exercise the scanner.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSecrets } from '../lib/secrets.mjs';

const SKIP_DIRS = new Set(['node_modules', 'vendor', '.hackconnect', '.git', 'test', 'e2e', '.opencode', 'bridge-config']);
const SKIP_FILES = new Set(['package-lock.json', 'secrets.mjs', 'check-secrets.mjs']); // the scanner's own rule definitions
const TEXT = /\.(md|mjs|js|json|yml|yaml|cmd|env|example|txt|html|css)$|Dockerfile|Caddyfile|\.gitignore|\.dockerignore/;

export function scanRepo(root) {
  const findings = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name); const rel = relative(root, full).split(sep).join('/'); const st = statSync(full);
      if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(full); continue; }
      if (name === '.env' || SKIP_FILES.has(name) || st.size > 1_000_000 || !(TEXT.test(name) || name === '.env.example')) continue;
      const hits = scanSecrets(readFileSync(full, 'utf8')); if (hits.length) findings.push({ file: rel, rules: hits });
    }
  };
  walk(root);
  // `.env` must never be tracked or shipped
  for (const f of ['.gitignore', '.dockerignore']) if (existsSync(join(root, f)) && !/^\.env$/m.test(readFileSync(join(root, f), 'utf8'))) findings.push({ file: f, rules: ['.env is not ignored'] });
  return findings;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const findings = scanRepo(fileURLToPath(new URL('..', import.meta.url)));
  if (findings.length) { console.error('Possible secrets found (values not printed):'); for (const f of findings) console.error(`  ${f.file}: ${f.rules.join(', ')}`); console.error('\nRemove them, then REVOKE the exposed keys at the provider: deleting a file does not un-leak a key.'); process.exit(1); }
  console.log('No secrets found in committed/published files.');
}
