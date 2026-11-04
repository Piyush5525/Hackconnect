// The CI/deploy files cannot run here, so validate everything about them that can be checked offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { scanRepo } from '../scripts/check-secrets.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)); const read = (f) => readFileSync(join(root, f), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('no real-looking secrets in committed or published files', () => {
  const findings = scanRepo(root); assert.deepEqual(findings, [], `secrets found (values hidden): ${JSON.stringify(findings)}`);
});

test('GitHub workflows are valid YAML and only call npm scripts that exist', () => {
  const dir = join(root, '.github/workflows'); const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)); assert.ok(files.length >= 2);
  for (const f of files) {
    const wf = parse(readFileSync(join(dir, f), 'utf8')); assert.ok(wf.name && wf.on && wf.jobs, `${f} has name/on/jobs`);
    for (const [jobName, job] of Object.entries(wf.jobs)) {
      assert.ok(job['runs-on'], `${f}:${jobName} runs-on`); assert.ok(Array.isArray(job.steps) && job.steps.length, `${f}:${jobName} steps`);
      for (const step of job.steps) {
        assert.ok(step.uses || step.run, `${f}:${jobName} step needs uses or run`);
        if (step.uses) assert.match(step.uses, /^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[\w.-]+$|^\.\//, `${f}: bad action ref ${step.uses}`);
        for (const m of String(step.run || '').matchAll(/npm run ([\w:-]+)/g)) assert.ok(pkg.scripts[m[1]], `${f}: npm run ${m[1]} is not defined in package.json`);
        for (const m of String(step.run || '').matchAll(/node (scripts\/[\w.-]+)/g)) assert.ok(existsSync(join(root, m[1])), `${f}: ${m[1]} does not exist`);
      }
    }
  }
});

test('Dockerfile copies only paths that exist and builds the client in a build stage', () => {
  const docker = read('Dockerfile'); assert.match(docker, /FROM node:22-alpine AS build/); assert.ok(/^USER node/m.test(docker) || (/ENTRYPOINT \["docker-entrypoint\.sh"\]/.test(docker) && /su-exec node/.test(read('docker-entrypoint.sh'))), 'the app must not run as root (USER node, or an entrypoint that drops to node)'); assert.match(docker, /HEALTHCHECK/);
  for (const m of docker.matchAll(/^COPY (?!--from)(.+)$/gm)) { const parts = m[1].trim().split(/\s+/); for (const src of parts.slice(0, -1)) assert.ok(existsSync(join(root, src.replace(/\/$/, ''))) || src.includes('*'), `Dockerfile COPY source missing: ${src}`); }
  // every file the server serves statically must be copied into the image
  const served = [...read('lib/app.mjs').matchAll(/\['([\w./-]+\.(?:html|js))'/g)].map((m) => m[1]).filter((f) => !f.startsWith('vendor/'));
  for (const f of new Set(served)) assert.ok(docker.includes(f), `${f} is served by the app but not copied by the Dockerfile`);
  assert.match(read('.dockerignore'), /^\.env$/m);
});

test('compose files and Caddyfile are consistent', () => {
  for (const f of ['docker-compose.yml', 'docker-compose.prod.yml']) { const c = parse(read(f)); assert.ok(c.services?.hackconnect, `${f} defines the app service`); }
  const prod = parse(read('docker-compose.prod.yml')); assert.ok(prod.services.caddy && prod.services.hackconnect.read_only === true); assert.deepEqual(prod.services.hackconnect.cap_drop, ['ALL']);
  const mount = prod.services.caddy.volumes.find((v) => v.includes('Caddyfile')); assert.ok(existsSync(join(root, mount.split(':')[0])), 'Caddyfile mount source exists'); assert.match(read('infra/Caddyfile'), /reverse_proxy hackconnect:4173/);
});

test('package.json scripts and bin point at real files; strict CSP has no inline scripts', () => {
  for (const [name, cmd] of Object.entries(pkg.scripts)) for (const m of cmd.matchAll(/node ([\w./-]+\.mjs)/g)) assert.ok(existsSync(join(root, m[1])), `script ${name} -> ${m[1]} missing`);
  assert.ok(existsSync(join(root, pkg.bin.hackconnect))); assert.ok(!/<script>/i.test(read('index.html')), 'index.html has an inline <script>');
  assert.ok(!/script-src[^;]*unsafe-inline/.test(read('lib/app.mjs')), 'CSP must not allow inline scripts'); assert.match(read('.gitignore'), /^vendor\/$/m);
});
