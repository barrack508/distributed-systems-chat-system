/**
 * server/chat.js
 * Chat delivery, publishing, and client message handling.
 */
const crypto = require('crypto');
const { NODE_ID, config, log } = require('./config');
const state = require('./state');
const { apply, persist, visibleTo } = require('./log');
const { broadcastUsers, announcePresence } = require('./peers');

const { send, toLocalClients, toPeers } = state;

/** Send an entry to the local clients that are allowed to see it. */
function deliver(e) {
  if (e.t === 'user') return broadcastUsers();
  if (e.t === 'group') {
    e.members.forEach((u) => { const ws = state.localUsers.get(u); if (ws) send(ws, { type: 'group', group: e }); });
    return;
  }
  if (e.conv === 'general') return toLocalClients({ type: 'chat', ...e });
  const recipients = e.conv.startsWith('dm:')
    ? [e.from, e.to]
    : (state.groups.get(e.group) || { members: [] }).members;
  recipients.forEach((u) => { const ws = state.localUsers.get(u); if (ws) send(ws, { type: 'chat', ...e }); });
}

/** Store an entry, deliver it locally and relay it to every peer node. */
function publish(e) {
  if (!apply(e)) return;
  persist(e);
  deliver(e);
  toPeers({ type: 'p-entry', e });
}

const dmConv = (a, b) => `dm:${[a, b].sort().join('|')}`;

function handleClientMessage(ws, raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return send(ws, { type: 'error', text: 'Invalid JSON' }); }

  if (m.type === 'join') {
    const name = String(m.user || '').trim();
    if (!/^[\w.-]{2,20}$/.test(name)) {
      return send(ws, { type: 'error', fatal: true, text: 'Username must be 2-20 characters: letters, digits, _ . -' });
    }
    // If username is taken by a connected user, disconnect the old session (login takes over).
    const existingNode = state.userNode(name);
    if (existingNode === NODE_ID) {
      const oldWs = state.localUsers.get(name);
      if (oldWs) {
        send(oldWs, { type: 'error', fatal: true, text: 'You were signed out because the same username logged in elsewhere.' });
        oldWs.close();
      }
    } else if (existingNode) {
      send(ws, { type: 'error', fatal: true, text: `"${name}" is currently active on ${existingNode}. Wait for them to disconnect or try again.` });
      return;
    }
    ws.user = name;
    state.localUsers.set(name, ws);
    const ue = { id: `u:${name}`, t: 'user', name, ts: Date.now() };
    if (apply(ue)) { persist(ue); toPeers({ type: 'p-entry', e: ue }); }
    const visible = state.entries.filter((e) => visibleTo(name, e));
    const history = [
      ...visible.filter((e) => e.conv === 'general').slice(-config.historySize),
      ...visible.filter((e) => e.conv !== 'general').slice(-500),
    ].sort((a, b) => a.ts - b.ts);
    send(ws, {
      type: 'welcome', node: NODE_ID, user: name,
      online: state.allUsers(), known: [...state.known].sort(),
      groups: [...state.groups.values()].filter((g) => g.members.includes(name)),
      allGroups: [...state.groups.values()],
      pendingRequests: [...state.groupRequests.entries()]
        .filter(([, reqs]) => reqs.some(r => r.user === name)).map(([gid]) => gid),
      history,
    });
    announcePresence();
    broadcastUsers();
    log(`+ ${name}  (local clients: ${state.localUsers.size})`);
    return;
  }

  if (!ws.user) return send(ws, { type: 'error', text: 'Send a join message first' });
  const text = String(m.text || '').slice(0, 1000);
  const base = { id: crypto.randomUUID(), t: 'msg', from: ws.user, text, ts: Date.now(), node: NODE_ID };

  if (m.type === 'chat') { // public Workspace room
    if (text.trim()) publish({ ...base, conv: 'general' });

  } else if (m.type === 'dm') { // one-to-one chat (the recipient may be offline)
    const to = String(m.to || '');
    if (!text.trim()) return;
    if (!state.known.has(to) || to === ws.user) return send(ws, { type: 'error', text: `User "${to}" not found` });
    publish({ ...base, conv: dmConv(ws.user, to), to });

  } else if (m.type === 'gchat') { // message in a group
    const g = state.groups.get(m.group);
    if (!g || !g.members.includes(ws.user)) return send(ws, { type: 'error', text: 'You are not a member of that group' });
    if (text.trim()) publish({ ...base, conv: `grp:${g.id}`, group: g.id });

  } else if (m.type === 'group-create') {
    const name = String(m.name || '').trim().slice(0, 30);
    const members = [...new Set((Array.isArray(m.members) ? m.members : []).filter((u) => state.known.has(u) && u !== ws.user))];
    if (!name) return send(ws, { type: 'error', text: 'Give the group a name' });
    if (!members.length) return send(ws, { type: 'error', text: 'Pick at least one other member' });
    publish({ id: `g:${crypto.randomUUID()}`, t: 'group', name, members: [ws.user, ...members], creator: ws.user, ts: Date.now() });

  } else if (m.type === 'group-request') {
    const g = state.groups.get(m.group);
    if (!g) return send(ws, { type: 'error', text: 'Group not found' });
    if (g.members.includes(ws.user)) return send(ws, { type: 'error', text: 'You are already a member' });
    if (!state.groupRequests.has(m.group)) state.groupRequests.set(m.group, []);
    const reqs = state.groupRequests.get(m.group);
    if (reqs.some(r => r.user === ws.user)) return send(ws, { type: 'error', text: 'Request already pending' });
    reqs.push({ user: ws.user, ts: Date.now() });
    const creatorWs = state.localUsers.get(g.creator);
    if (creatorWs) send(creatorWs, { type: 'join-request', group: g, user: ws.user, ts: Date.now() });
    send(ws, { type: 'request-sent', group: m.group });

  } else if (m.type === 'group-approve') {
    const g = state.groups.get(m.group);
    if (!g || g.creator !== ws.user) return send(ws, { type: 'error', text: 'Only the group creator can approve requests' });
    const reqs = state.groupRequests.get(m.group) || [];
    const idx = reqs.findIndex(r => r.user === m.requestUser);
    if (idx === -1) return send(ws, { type: 'error', text: 'No pending request from that user' });
    reqs.splice(idx, 1);
    g.members.push(m.requestUser);
    const updatedGroup = { ...g, ts: Date.now() };
    publish(updatedGroup);
    send(ws, { type: 'request-approved', group: m.group, user: m.requestUser });
    const approvedWs = state.localUsers.get(m.requestUser);
    if (approvedWs) send(approvedWs, { type: 'group', group: updatedGroup });

  } else if (m.type === 'group-reject') {
    const g = state.groups.get(m.group);
    if (!g || g.creator !== ws.user) return send(ws, { type: 'error', text: 'Only the group creator can reject requests' });
    const reqs = state.groupRequests.get(m.group) || [];
    const idx = reqs.findIndex(r => r.user === m.requestUser);
    if (idx !== -1) reqs.splice(idx, 1);
    send(ws, { type: 'request-rejected', group: m.group, user: m.requestUser });
  }
}

module.exports = { deliver, publish, handleClientMessage };
