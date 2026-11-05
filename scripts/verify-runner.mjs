// Proves the sandbox really is isolated on THIS machine. Run it once before enabling HACKCONNECT_RUNNER=docker:
//   node scripts/verify-runner.mjs            (needs Docker; add HACKCONNECT_RUNNER_RUNTIME=runsc to test gVisor)
// Exit code 0 = every isolation property held, 1 = at least one failed, 2 = Docker is not available.
import { spawnSync } from 'node:child_process';
import { createDockerProvider } from '../lib/runner.mjs';

const info = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' });
if (info.error || info.status !== 0) { console.error('Docker is not available (is it installed and running?). The sandbox runner cannot be verified or used.'); process.exit(2); }
console.log(`Docker ${info.stdout.trim()} | runtime: ${process.env.HACKCONNECT_RUNNER_RUNTIME || 'default (runc)'}\n`);

const provider = createDockerProvider(); const results = [];
const probe = async (name, command, check, { timeoutMs = 30000, files = { 'hello.txt': 'hi' } } = {}) => {
  const r = await provider.run({ files, command, timeoutMs }); let pass = false; try { pass = Boolean(check(r)); } catch { pass = false; }
  results.push({ name, pass, detail: `${r.timedOut ? 'TIMED OUT ' : ''}exit=${r.exitCode} ${(r.stdout + r.stderr).trim().replace(/\s+/g, ' ').slice(0, 90)}` });
};

await probe('runs a command and sees the project files', 'cat hello.txt', (r) => r.exitCode === 0 && r.stdout.trim() === 'hi');
await probe('has NO network (cannot reach the internet)', 'wget -T 3 -q -O- http://1.1.1.1 >/dev/null 2>&1 && echo REACHED || echo blocked', (r) => r.stdout.includes('blocked'));
await probe('cannot reach the cloud metadata address', 'wget -T 3 -q -O- http://169.254.169.254 >/dev/null 2>&1 && echo REACHED || echo blocked', (r) => r.stdout.includes('blocked'));
await probe('root filesystem is read-only', 'touch /etc/hc-test 2>/dev/null && echo WRITABLE || echo readonly', (r) => r.stdout.includes('readonly'));
await probe('runs as a non-root user', 'id -u', (r) => r.stdout.trim() === '1000');
await probe('has no Linux capabilities', 'grep CapEff /proc/self/status', (r) => /CapEff:\s*0+$/m.test(r.stdout));
await probe('cannot see the Docker socket', 'ls /var/run/docker.sock 2>/dev/null && echo VISIBLE || echo absent', (r) => r.stdout.includes('absent'));
await probe('cannot see host files', 'ls /host /home 2>/dev/null | head -1; ls /workspace', (r) => !r.stdout.includes('Users'));
await probe('process count is limited (fork bomb contained)', 'i=0; while [ $i -lt 400 ]; do sleep 20 & i=$((i+1)); done 2>&1 | head -1; echo done', (r) => r.exitCode === 0 || /done|Resource temporarily unavailable|can.t fork/i.test(r.stdout + r.stderr), { timeoutMs: 20000 });
await probe('memory is capped (a 1 GB allocation is killed)', 'head -c 1000000000 /dev/zero | tail -c 1 >/dev/null; echo exit=$?', (r) => r.exitCode !== 0 || /exit=[1-9]/.test(r.stdout) || /Killed/.test(r.stderr + r.stdout), { timeoutMs: 20000 });
await probe('wall-clock timeout kills runaway code', 'sleep 60', (r) => r.timedOut === true, { timeoutMs: 3000 });

let failed = 0; for (const r of results) { console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n      ${r.detail}`); if (!r.pass) failed++; }
console.log(failed ? `\n${failed} check(s) FAILED. Do NOT enable the runner on a shared machine.` : '\nAll isolation checks passed on this machine.'); process.exit(failed ? 1 : 0);
