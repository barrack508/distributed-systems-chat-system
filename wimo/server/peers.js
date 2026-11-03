/**
 * server/peers.js
 * Full-mesh peer-to-peer links between nodes.
 * Dial rule: only dial peers whose id is greater than our own to ensure exactly
 * one link between any pair.
 */
const { WebSocket } = require('ws');
const { NODE_ID, peers, log } = require('./config');
const state = require('./state');
const { apply, persist, lastTs } = require('./log');

const { send, toLocalClients, toPeers } = state;

const broadcastUsers = () => toLocalClients({ type: 'users', online: state.allUsers(), known: [...state.known].sort() });
const announcePresence = () => toPeers({ type: 'p-presence', node: NODE_ID, users: [...state.localUsers.keys()] });

/** Handle one message arriving from a peer (works for inbound and outbound links). */
function onPeerMessage(ws, raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return; }

  switch (m.type) {
    case 'p-hello': // handshake: register the link, then exchange state
      if (ws.inbound && !ws.helloSent) { ws.helloSent = true; send(ws, { type: 'p-hello', node: NODE_ID }); }
      ws.peerId = m.node;
      state.peerLinks.set(m.node, ws);
      log(`peer ${m.node} linked  (links up: ${[...state.peerLinks.keys()].join(', ')})`);
      send(ws, { type: 'p-presence', node: NODE_ID, users: [...state.localUsers.keys()] });
      send(ws, { type: 'p-sync-req', since: lastTs() });
      break;

    case 'p-entry': { // a message / group / user entry created on another node
      const { deliver } = require('./chat'); // lazy to avoid circular import
      if (apply(m.e)) { persist(m.e); deliver(m.e); }
      break;
    }

    case 'p-presence':
      state.remoteUsers.set(m.node, new Set(m.users));
      broadcastUsers();
      break;

    case 'p-sync-req': // peer was offline / just joined: send what it missed (5s overlap; ids de-duplicate)
      send(ws, { type: 'p-sync-res', entries: state.entries.filter((x) => x.ts > m.since - 5000) });
      break;

    case 'p-sync-res': {
      const { deliver } = require('./chat');
      let added = 0;
      for (const e of m.entries) if (apply(e)) { added++; persist(e); deliver(e); }
      if (added) log(`synced ${added} missed entr${added === 1 ? 'y' : 'ies'} from ${ws.peerId}`);
      break;
    }
  }
}

function onPeerClosed(ws) {
  if (ws.peerId && state.peerLinks.get(ws.peerId) === ws) {
    state.peerLinks.delete(ws.peerId);
    state.remoteUsers.delete(ws.peerId);
    log(`peer ${ws.peerId} DOWN  (links up: ${[...state.peerLinks.keys()].join(', ') || 'none'})`);
    broadcastUsers();
  }
}

/** Outbound link: we dial peers with a larger id and keep retrying forever. */
function dialPeer(peer) {
  const connect = () => {
    const ws = new WebSocket(`ws://${peer.host}:${peer.port}/peer`);
    ws.on('open', () => send(ws, { type: 'p-hello', node: NODE_ID }));
    ws.on('message', (raw) => onPeerMessage(ws, raw));
    ws.on('close', () => { onPeerClosed(ws); setTimeout(connect, 2000); });
    ws.on('error', () => {}); // 'close' follows; the retry is handled there
  };
  connect();
}

function startPeerLinks() {
  peers.filter((p) => p.id > NODE_ID).forEach(dialPeer);
}

module.exports = { onPeerMessage, onPeerClosed, startPeerLinks, broadcastUsers, announcePresence };
