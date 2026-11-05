export async function githubSync(item, body, userToken = null) {
  // Only the signed-in user's own connected GitHub account is ever used (never a server-wide token).
  const token = userToken; if (!token) throw new Error('Connect your GitHub account first: click Connections, then Connect GitHub.');
  const api = process.env.HACKCONNECT_GITHUB_API_URL || 'https://api.github.com';
  const owner = String(body.owner || '').trim(); const repo = String(body.repo || '').trim(); const branch = String(body.branch || 'main').trim();
  if (!owner || !repo) throw new Error('owner and repo are required');
  const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'HackConnect' };
  let synced = 0;
  for (const [path, content] of Object.entries(item.files).slice(0, 100)) {
    const endpoint = `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
    const existing = await fetch(`${endpoint}?ref=${encodeURIComponent(branch)}`, { headers });
    const current = existing.ok ? await existing.json() : {};
    const response = await fetch(endpoint, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ message: `sync: ${item.name} from HackConnect`, content: Buffer.from(content, 'utf8').toString('base64'), branch, ...(current.sha ? { sha: current.sha } : {}) }) });
    if (!response.ok) throw new Error(`GitHub rejected ${path} (${response.status})`); synced++;
  }
  return { synced, repo: `${owner}/${repo}`, branch };
}
