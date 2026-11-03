/**
 * server/index.js
 * Wimo - Distributed Chat Server Node
 * ------------------------------
 * Usage:  node server/index.js <nodeId>      e.g.  node server/index.js node1
 *
 * Every node:
 *   1. serves the web UI (public/index.html) and a small HTTP API
 *   2. accepts chat CLIENTS over WebSocket at  ws://host:port/chat
 *      (public "Workspace" room, one-to-one chats, user-created groups)
 *   3. keeps a full-mesh link to every other node (PEERS) at ws://host:port/peer
 *      and relays every message to them, so users on different nodes can talk
 *   4. appends every message to its own log file (data/<nodeId>.log) so history
 *      survives a crash, and re-syncs missed messages from its peers on restart
 *
 * Peer dialing rule: a node only dials peers whose id is greater than its own.
 * This guarantees exactly ONE link between any two nodes (no duplicate links).
 */
const { WebSocketServer } = require('ws');
const { NODE_ID, self, config, log } = require('./config');
const state = require('./state');
require('./log'); // ensures log file is loaded at startup
const { startPeerLinks, onPeerMessage, onPeerClosed, announcePresence, broadcastUsers } = require('./peers');
const { handleClientMessage } = require('./chat');
const { createHttpServer } = require('./http');

// ----- HTTP server (static + /api) -----
const httpServer = createHttpServer();

// ----- WebSocket server (clients + peers) -----
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  const url = req.url.split('?')[0];
  if (url !== '/chat' && url !== '/peer') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('error', () => {});
    if (url === '/peer') {
      ws.inbound = true;
      ws.on('message', (raw) => onPeerMessage(ws, raw));
      ws.on('close', () => onPeerClosed(ws));
    } else {
      ws.on('message', (raw) => handleClientMessage(ws, raw));
      ws.on('close', () => {
        if (ws.user && state.localUsers.get(ws.user) === ws) {
          state.localUsers.delete(ws.user);
          announcePresence();
          broadcastUsers();
          log(`- ${ws.user}  (local clients: ${state.localUsers.size})`);
        }
      });
    }
  });
});

// ----- Heartbeat: drop dead connections so presence stays accurate -----
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, config.heartbeatMs);

// ----- Kick off peer links and start listening -----
startPeerLinks();

httpServer.listen(self.port, () => {
  log(`listening on http://${self.host}:${self.port}   (peers: ${config.nodes.filter((n) => n.id !== NODE_ID).map((p) => p.id).join(', ') || 'none'})`);
});

process.on('SIGINT', () => { log('shutting down'); process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
