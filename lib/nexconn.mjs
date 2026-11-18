// Nexconn (https://nexconn.ai) powers the Team hub: project channels, discussion threads, the shift-handover channel,
// direct messages and the shared AI assistant. The browser renders it with the Nexconn ChatUI SDK (@nexconn/chatui);
// this module is the trusted side:
//  - it signs Platform API requests with the App Secret (which never leaves the server),
//  - issues each signed-in person their own Nexconn access token,
//  - creates one Nexconn group channel per project channel and keeps its member list equal to the project's members,
//  - posts the shared assistant's answers (and join notices) into a channel as a bot user, so the whole team sees them.
// Without NEXCONN_KEY / NEXCONN_SECRET everything here reports "not configured" and the rest of the app works as before.
import crypto from 'node:crypto';
import { workspaceRole } from './policy.mjs';

/** Nexconn user ids allow letters and digits only; ours are UUIDs. */
export const nxUserId = (id) => `u${String(id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 60)}`;
export const BOT = { id: 'hcassistant', name: 'HackConnect AI' };
export const DEFAULT_CHANNELS = [
  { key: 'general', name: 'general', topic: 'Everything about this project. Start here.' },
  { key: 'handover', name: 'handover', topic: 'Going offline? Leave a handover: what is done, what is next, what is blocked.' },
];
const MAX_THREADS = 40;
/** ChatUI shows text messages as plain text, so Markdown from a model would appear as literal ** and ```. */
export const plainText = (text) => String(text || '')
  .replace(/```[a-z0-9+-]*\n?([\s\S]*?)```/gi, (_, code) => code.trimEnd()) // keep the code, drop the fences
  .replace(/^#{1,6}\s+/gm, '').replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1').replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, '$1$2')
  .replace(/`([^`\n]+)`/g, '$1').replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1 ($2)').replace(/^\s*[*+]\s+/gm, '- ').replace(/\n{3,}/g, '\n\n').trim();
const cleanName = (value) => String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export function createNexconn({ db, json, save, project, askAssistant, audit = () => {}, fetchImpl = (...a) => fetch(...a), env = process.env }) {
  db.nexconn ||= {}; db.nexconn.tokens ||= {};
  // Default: the Singapore data centre. For an app in another data centre set both the Platform API host and the
  // browser SDK's AreaCode (1 Beijing, 2 Singapore, 3 North America, 5 South America, 6 Oman) from the Nexconn console.
  const config = () => ({ appKey: env.NEXCONN_KEY || '', secret: env.NEXCONN_SECRET || '', host: env.NEXCONN_API_HOST || 'api.sg-light-api.com', areaCode: Number(env.NEXCONN_AREA_CODE) || 2 });
  const enabled = () => { const c = config(); return Boolean(c.appKey && c.secret); };

  /** Signed Platform API call. Throws with a readable message when Nexconn refuses. */
  async function call(path, body) {
    const { appKey, secret, host } = config(); if (!appKey || !secret) throw new Error('Nexconn is not configured');
    const nonce = crypto.randomBytes(8).toString('hex'); const timestamp = String(Date.now());
    const signature = crypto.createHash('sha1').update(secret + nonce + timestamp).digest('hex');
    const response = await fetchImpl(`https://${host}${path}`, { method: 'POST', headers: { 'App-Key': appKey, Nonce: nonce, Timestamp: timestamp, Signature: signature, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || (data.code !== 0 && data.code !== 200)) { const error = new Error(`Nexconn ${path} failed: ${data.errorMessage || data.msg || data.message || `HTTP ${response.status}`}`); error.nexconnCode = data.code; throw error; }
    return data;
  }

  /** Issue (and remember) a person's access token. Issuing is also what registers them with Nexconn. */
  async function tokenFor(user) {
    const cached = db.nexconn.tokens[user.id]; if (cached && cached.name === user.name && cached.appKey === config().appKey) return cached.token;
    const data = await call('/v4/auth/access-token/issue', { userId: nxUserId(user.id), name: String(user.name || 'Member').slice(0, 64) });
    const token = data.result?.accessToken || data.token; if (!token) throw new Error('Nexconn did not return an access token');
    db.nexconn.tokens[user.id] = { token, name: user.name, appKey: config().appKey }; save(); return token;
  }
  let botReady = null;
  const ensureBot = () => (botReady ||= call('/v4/auth/access-token/issue', { userId: BOT.id, name: BOT.name }).catch((error) => { botReady = null; throw error; }));

  const memberUsers = (item) => Object.keys(item.members || {}).map((id) => db.users.find((u) => u.id === id)).filter((u) => u && !u.suspended);
  const batches = (list, size) => { const out = []; for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size)); return out; };
  /** Channels created under another Nexconn app (the key was changed) no longer exist; forget them so they are recreated. */
  const liveChannels = (item) => { const key = config().appKey; const before = (item.channels ||= []).length; item.channels = item.channels.filter((c) => (c.appKey || key) === key); if (item.channels.length !== before) save(); return item.channels; };

  async function createChannel(item, { key = null, name, topic = '', createdBy = null }) {
    const members = memberUsers(item); await Promise.all(members.map((u) => tokenFor(u)));
    const ownerId = createdBy && item.members[createdBy] ? createdBy : (Object.keys(item.members).find((id) => item.members[id] === 'owner') || members[0]?.id);
    const channel = { id: `c${crypto.randomBytes(14).toString('hex')}`, key, name, topic, createdBy, at: Date.now(), joined: [], appKey: config().appKey };
    const others = members.filter((u) => u.id !== ownerId).map((u) => nxUserId(u.id));
    await call('/v4/group-channel/create', { channelId: channel.id, name: `${item.name} · ${name}`.slice(0, 64), owner: nxUserId(ownerId), userIds: others.slice(0, 30) });
    for (const group of batches(others.slice(30), 100)) await call('/v4/group-channel/join', { channelId: channel.id, userIds: group });
    channel.joined = members.map((u) => u.id); (item.channels ||= []).push(channel); save(); return channel;
  }

  /** Make the Nexconn groups match the project: default channels exist, new members are added, removed members are taken out. */
  const syncing = new Map(); const again = new Map();
  function syncProject(item) {
    // A sync already running may have started before the latest membership change, so queue exactly one more run after it.
    if (syncing.has(item.id)) { if (!again.has(item.id)) again.set(item.id, syncing.get(item.id).catch(() => {}).then(() => { again.delete(item.id); return syncProject(item); })); return again.get(item.id); }
    const run = (async () => {
      liveChannels(item);
      const members = memberUsers(item); const ids = new Set(members.map((u) => u.id));
      for (const channel of [...item.channels]) {
        const add = members.filter((u) => !channel.joined.includes(u.id)); const drop = channel.joined.filter((id) => !ids.has(id));
        try {
          if (add.length) { await Promise.all(add.map((u) => tokenFor(u))); for (const group of batches(add.map((u) => nxUserId(u.id)), 100)) await call('/v4/group-channel/join', { channelId: channel.id, userIds: group }); }
          if (drop.length) for (const group of batches(drop.map(nxUserId), 100)) await call('/v4/group-channel/leave', { channelId: channel.id, userIds: group });
        } catch (error) {
          // Nexconn itself refused (not a network failure): the channel belongs to an app this server no longer uses. Forget it; defaults are recreated below.
          if (error.nexconnCode === undefined) throw error; console.error(`${error.message}; recreating channel ${channel.name} of ${item.name}`);
          item.channels = item.channels.filter((c) => c !== channel); save(); continue;
        }
        if (add.length || drop.length) { channel.joined = [...ids]; save(); }
        if (add.length && channel.key === 'general') postBot(channel.id, `👋 ${add.map((u) => u.name).join(', ')} joined ${item.name}. Say hi, and check #handover for where things stand.`).catch((error) => console.error(error.message));
      }
      for (const def of DEFAULT_CHANNELS) if (!item.channels.some((c) => c.key === def.key)) await createChannel(item, def);
    })().finally(() => syncing.delete(item.id));
    syncing.set(item.id, run); return run;
  }

  const person = (u) => ({ nx: nxUserId(u.id), id: u.id, name: u.name, username: u.username || '', initials: u.initials || '?', avatar: /^https:\/\//.test(u.avatar || '') ? u.avatar : '' });
  const channelView = (c) => ({ id: c.id, key: c.key, name: c.name, topic: c.topic || '', kind: c.key === 'handover' ? 'handover' : c.key === 'general' ? 'general' : 'thread', createdBy: c.createdBy, at: c.at });

  /** Post a text message into a channel as the bot user, so the whole team gets it at the same moment. */
  async function postBot(channelId, text, extra = {}) {
    await ensureBot(); const body = plainText(text).slice(0, 9000) || 'I have no answer for that.';
    const content = JSON.stringify({ content: body, extra: JSON.stringify({ ai: true, ...extra }), user: { id: BOT.id, name: BOT.name } });
    const sent = await call('/v4/group-channel/message/send', { fromUserId: BOT.id, toChannelIds: [channelId], messageType: 'RC:TxtMsg', content });
    return { messageId: sent.result?.messageIds?.[0]?.messageId };
  }

  async function handle({ req, res, user, parts, body }) {
    const method = req.method;
    if (parts[1] === 'nexconn' && parts[2] === 'session' && method === 'GET') {
      if (!enabled()) return json(res, 200, { enabled: false }), true;
      try { const c = config(); return json(res, 200, { enabled: true, appKey: c.appKey, areaCode: c.areaCode, token: await tokenFor(user), userId: nxUserId(user.id), bot: BOT }), true; } catch (error) { console.error(error.message); return json(res, 502, { error: 'Could not reach the messaging service. Try again in a moment.' }), true; }
    }
    if (parts[1] === 'hub' && parts.length === 2 && method === 'GET') {
      if (!enabled()) return json(res, 200, { enabled: false, projects: [], people: {} }), true;
      const mine = db.projects.filter((item) => workspaceRole(item, user) !== null); const people = {}; const projects = [];
      await Promise.all(mine.map((item) => syncProject(item).then(() => { item._nxReady = true; }, (error) => { item._nxReady = false; console.error(error.message); })));
      for (const item of mine) {
        const members = memberUsers(item); for (const u of members) people[nxUserId(u.id)] ||= person(u);
        projects.push({ id: item.id, name: item.name, role: workspaceRole(item, user), ready: item._nxReady !== false, channels: liveChannels(item).map(channelView), members: members.map((u) => ({ nx: nxUserId(u.id), role: item.members[u.id] })) });
      }
      for (const c of (db.connections || []).filter((x) => x.status === 'accepted' && (x.from === user.id || x.to === user.id))) { const other = db.users.find((u) => u.id === (c.from === user.id ? c.to : c.from)); if (other && !other.suspended) people[nxUserId(other.id)] ||= person(other); }
      people[BOT.id] = { nx: BOT.id, id: BOT.id, name: BOT.name, username: 'assistant', initials: 'AI', avatar: '', bot: true };
      return json(res, 200, { enabled: true, me: nxUserId(user.id), projects, people }), true;
    }
    if (parts[1] === 'hub' && parts[2] === 'people' && method === 'POST') { // profiles for Nexconn ids the browser has not seen yet (e.g. a former teammate in an old DM)
      const wanted = new Set((Array.isArray(body.ids) ? body.ids : []).slice(0, 200).map(String)); const out = [];
      for (const u of db.users) if (!u.suspended && wanted.has(nxUserId(u.id))) out.push({ nx: nxUserId(u.id), name: u.name, avatar: person(u).avatar });
      if (wanted.has(BOT.id)) out.push({ nx: BOT.id, name: BOT.name, avatar: '' });
      return json(res, 200, { people: out }), true;
    }
    if (parts[1] === 'projects' && parts[3] === 'channels') {
      const item = project(parts[2]); if (!item || workspaceRole(item, user) === null) return json(res, 404, { error: 'Project not found' }), true;
      if (!enabled()) return json(res, 503, { error: 'Team messaging is not configured on this server' }), true;
      const role = workspaceRole(item, user); const canWrite = role !== 'viewer';
      if (!parts[4] && method === 'POST') {
        if (!canWrite) return json(res, 403, { error: 'Viewers cannot start threads' }), true;
        const name = cleanName(body.name); if (name.length < 2) return json(res, 400, { error: 'Give the thread a short name, for example "api-design"' }), true;
        try { await syncProject(item); } catch (error) { console.error(error.message); return json(res, 502, { error: 'Could not reach the messaging service. Try again.' }), true; }
        if (item.channels.some((c) => c.name === name)) return json(res, 409, { error: `There is already a #${name} here` }), true;
        if (item.channels.length >= MAX_THREADS + DEFAULT_CHANNELS.length) return json(res, 409, { error: 'This project has reached its thread limit. Archive one first.' }), true;
        try { const channel = await createChannel(item, { name, topic: String(body.topic || '').slice(0, 200), createdBy: user.id }); audit(user, 'channel.create', item.id, name); return json(res, 201, channelView(channel)), true; } catch (error) { console.error(error.message); return json(res, 502, { error: 'Could not create the thread. Try again.' }), true; }
      }
      const channel = (item.channels || []).find((c) => c.id === parts[4]); if (!channel) return json(res, 404, { error: 'Channel not found' }), true;
      if (!parts[5] && method === 'DELETE') {
        if (channel.key) return json(res, 400, { error: 'The general and handover channels cannot be removed' }), true;
        if (role !== 'owner' && channel.createdBy !== user.id) return json(res, 403, { error: 'Only the thread starter or a project owner can archive it' }), true;
        try { await call('/v4/group-channel/dismiss', { channelId: channel.id }); } catch (error) { console.error(error.message); }
        item.channels = item.channels.filter((c) => c !== channel); audit(user, 'channel.archive', item.id, channel.name); save(); return json(res, 200, { ok: true }), true;
      }
      if (parts[5] === 'ask' && method === 'POST') {
        if (!canWrite) return json(res, 403, { error: 'Viewers cannot ask the assistant' }), true;
        const prompt = String(body.prompt || '').trim().slice(0, 4000); if (!prompt) return json(res, 400, { error: 'Ask the assistant something' }), true;
        const framed = `${user.name} asked this in the #${channel.name} team chat of the project "${item.name}". Reply to the whole team conversationally and briefly, in plain text (the chat does not render Markdown: no **bold**, no headings, no code fences; short dashed lists are fine). Do not propose file changes; mention code inline if needed.\n\nQuestion: ${prompt}`;
        let answer; try { answer = await askAssistant(user, item, framed); } catch (error) { return json(res, error.status || 502, { error: error.message || 'The assistant could not answer' }), true; }
        try { const out = await postBot(channel.id, answer.message, { provider: answer.provider || '', askedBy: user.name }); return json(res, 200, { ok: true, messageId: out.messageId }), true; } catch (error) { console.error(error.message); return json(res, 502, { error: 'The assistant answered but the reply could not be posted' }), true; }
      }
    }
    return false;
  }

  /** Project chat sent through HackConnect's own API (bridge CLI, editor extension, stickers) lands in #general on Nexconn, as that person. */
  async function postAs(user, item, text) {
    await syncProject(item); const general = item.channels.find((c) => c.key === 'general'); if (!general) throw new Error('The project chat is not ready yet');
    await tokenFor(user); const body = String(text || '').slice(0, 4000);
    const sent = await call('/v4/group-channel/message/send', { fromUserId: nxUserId(user.id), toChannelIds: [general.id], messageType: 'RC:TxtMsg', content: JSON.stringify({ content: body }) });
    return { id: sent.result?.messageIds?.[0]?.messageId || crypto.randomUUID(), channelId: general.id, userId: nxUserId(user.id), user: user.name, text: body, createdAt: Date.now(), via: 'nexconn' };
  }

  /** Best-effort cleanup when a project is deleted. */
  const dropProject = (item) => Promise.all((item.channels || []).map((c) => call('/v4/group-channel/dismiss', { channelId: c.id }).catch(() => {})));

  return { enabled, handle, call, tokenFor, syncProject, postBot, postAs, dropProject };
}
