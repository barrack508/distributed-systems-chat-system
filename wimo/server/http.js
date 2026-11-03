/**
 * server/http.js
 * HTTP server factory: serves static files from /public and exposes two
 * JSON API endpoints: /api/nodes and /api/status.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { ROOT, config, NODE_ID } = require('./config');
const state = require('./state');

const PUBLIC = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function createHttpServer() {
  return http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    if (url === '/api/nodes') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ self: NODE_ID, nodes: config.nodes }));
    }

    if (url === '/api/status') {
      // CORS header lets the web UI served by one node read the status of the others.
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({
        node: NODE_ID,
        uptimeSec: Math.round(process.uptime()),
        localClients: state.localUsers.size,
        peersUp: [...state.peerLinks.keys()],
        entriesStored: state.entries.length,
        users: state.known.size,
        groups: state.groups.size,
      }));
    }

    const file = path.join(PUBLIC, url === '/' ? 'index.html' : url);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
}

module.exports = { createHttpServer };
