// Sandbox provider interface + hardened Docker implementation (gVisor via HACKCONNECT_RUNNER_RUNTIME=runsc).
// SandboxProvider contract: run({ files, command, timeoutMs, network }) -> { exitCode, stdout, stderr, timedOut }
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import crypto from 'node:crypto';

const MAX_OUTPUT = 64 * 1024;

/** Pure: the exact argv passed to `docker`. Kept separate so the security posture is unit-tested. */
export function buildDockerArgs({ name, dir, command, image = 'node:22-alpine', runtime = '', network = false, memory = '256m', cpus = '0.5', pids = 128 }) {
  return ['run', '--rm', '--name', name,
    ...(runtime ? ['--runtime', runtime] : []),
    '--network', network ? 'bridge' : 'none',
    '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=64m',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', String(pids), '--memory', memory, '--memory-swap', memory, '--cpus', String(cpus),
    '--user', '1000:1000', '-e', 'HOME=/tmp', '-e', 'CI=true',
    '-v', `${dir}:/workspace:rw`, '-w', '/workspace',
    image, 'sh', '-c', command];
}

export function materialize(files) {
  const dir = mkdtempSync(join(tmpdir(), 'hc-run-')); const base = resolve(dir);
  for (const [path, content] of Object.entries(files)) {
    const target = resolve(dir, path); if (target !== base && !target.startsWith(base + sep)) continue; // never write outside the temp dir
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content);
  }
  return dir;
}

export function createDockerProvider({ image = process.env.HACKCONNECT_RUNNER_IMAGE || 'node:22-alpine', runtime = process.env.HACKCONNECT_RUNNER_RUNTIME || '', docker = 'docker' } = {}) {
  return {
    name: runtime ? `docker+${runtime}` : 'docker',
    async run({ files, command, timeoutMs = 30000, network = false }) {
      const dir = materialize(files); const name = `hc-${crypto.randomBytes(6).toString('hex')}`;
      try {
        return await new Promise((resolveRun) => {
          const child = spawn(docker, buildDockerArgs({ name, dir, command, image, runtime, network }), { windowsHide: true });
          let stdout = ''; let stderr = ''; let timedOut = false;
          const cap = (s, d) => (s.length < MAX_OUTPUT ? s + d.toString().slice(0, MAX_OUTPUT - s.length) : s);
          child.stdout.on('data', (d) => { stdout = cap(stdout, d); }); child.stderr.on('data', (d) => { stderr = cap(stderr, d); });
          const timer = setTimeout(() => { timedOut = true; spawn(docker, ['kill', name], { windowsHide: true }); }, timeoutMs);
          child.on('error', (e) => { clearTimeout(timer); resolveRun({ exitCode: -1, stdout, stderr: `Could not start docker: ${e.message}`, timedOut }); });
          child.on('close', (code) => { clearTimeout(timer); resolveRun({ exitCode: code ?? -1, stdout, stderr, timedOut }); });
        });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  };
}
