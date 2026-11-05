// Post-deploy smoke test: health, auth round-trip, and an authenticated bootstrap.
const base = process.env.HACKCONNECT_URL || 'http://127.0.0.1:4173';
let cookie = '';
const call = async (method, path, body) => {
  const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'hackconnect', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = response.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
const health = await call('GET', '/health');
const anon = await call('GET', '/api/bootstrap');
const email = `smoke-${Date.now()}@example.com`;
const signup = await call('POST', '/api/auth/signup', { name: 'Smoke Test', email, password: 'smoke-test-password' });
const bootstrap = await call('GET', '/api/bootstrap');
const status = await call('GET', '/api/integrations/status');
if (!health.body.ok || anon.status !== 401 || signup.status !== 201 || bootstrap.status !== 200 || !status.body.realtime) throw new Error(`Smoke assertions failed: ${JSON.stringify({ health: health.status, anon: anon.status, signup: signup.status, bootstrap: bootstrap.status })}`);
console.log(`HackConnect smoke OK · ${bootstrap.body.projects.length} projects visible · agent=${status.body.agent}`);
