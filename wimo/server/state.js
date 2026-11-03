/**
 * server/state.js
 * Shared mutable state containers and low-level send/broadcast helpers.
 * Kept as a single module to avoid circular dependencies between
 * log, peers, presence, and chat modules.
 */
const { WebSocket } = require('ws');

// ----- Replicated log state -----
const entries = [];              // all entries in timestamp order
const seen = new Set();          // ids already stored (de-duplication)
const groups = new Map();        // group id -> group entry
const known = new Set();         // every username ever seen

// ----- Presence -----
const localUsers = new Map();    // username -> ws (clients connected to this node)
const remoteUsers = new Map();   // nodeId -> Set(usernames) on that peer
const groupRequests = new Map(); // groupId -> [{user, ts}] pending join requests

// ----- Peer links -----
const peerLinks = new Map();     // peerId -> ws (open, handshaken links only)

// ----- Send helpers -----
const send = (ws, obj) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(obj));
const toLocalClients = (obj) => localUsers.forEach((ws) => send(ws, obj));
const toPeers = (obj) => peerLinks.forEach((ws) => send(ws, obj));

const allUsers = () => {
  const s = new Set(localUsers.keys());
  for (const set of remoteUsers.values()) for (const u of set) s.add(u);
  return [...s].sort();
};

const userNode = (name) => {
  if (localUsers.has(name)) return require('./config').NODE_ID;
  for (const [node, set] of remoteUsers) if (set.has(name)) return node;
  return null;
};

module.exports = {
  entries, seen, groups, known,
  localUsers, remoteUsers, groupRequests,
  peerLinks,
  send, toLocalClients, toPeers,
  allUsers, userNode,
};
