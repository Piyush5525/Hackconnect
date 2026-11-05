// Opens live sockets (room sync, calls, shared editor).
// Same address as the backend: the signed-in cookie is enough. Frontend on another address (Vercel + Render): ask the signed-in
// API for a one-time ticket and open the socket straight to the backend with it (Vercel cannot proxy WebSockets).
window.hcSocketUrl = async (path) => {
  const backend = String(window.HACKCONNECT_BACKEND || '').replace(/\/+$/, '');
  if (!backend) return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${path}`;
  const res = await fetch('/api/ws-ticket', { method: 'POST', credentials: 'same-origin', headers: { 'x-requested-with': 'hackconnect' } });
  const ticket = res.ok ? (await res.json()).ticket : 'signed-out'; // a bad ticket makes the server answer 4401, which the app already treats as "session expired"
  return `${backend.replace(/^http/i, 'ws')}${path}${path.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(ticket)}`;
};
