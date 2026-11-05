// Tunnel providers sit behind one interface so cloudflared can be swapped for another outbound-only tunnel.
// TunnelProvider: open({ port }) -> Promise<{ url, close() }>
import { spawn } from 'node:child_process';

export function cloudflaredProvider({ binary = process.env.CLOUDFLARED || 'cloudflared', timeoutMs = 30000 } = {}) {
  return {
    name: 'cloudflared',
    open({ port }) {
      return new Promise((resolve, reject) => {
        let child; try { child = spawn(binary, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${Number(port)}`], { windowsHide: true }); } catch (e) { return reject(e); }
        let done = false; const fail = (e) => { if (!done) { done = true; reject(e); } };
        const timer = setTimeout(() => { child.kill(); fail(new Error('Timed out waiting for the tunnel URL')); }, timeoutMs);
        const scan = (chunk) => { const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(chunk.toString()); if (m && !done) { done = true; clearTimeout(timer); resolve({ url: m[0], close: () => child.kill() }); } };
        child.stdout.on('data', scan); child.stderr.on('data', scan);
        child.on('error', (e) => fail(e.code === 'ENOENT' ? new Error('cloudflared is not installed. It is free: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/') : e));
        child.on('exit', (code) => fail(new Error(`cloudflared exited with code ${code}`)));
      });
    }
  };
}
