/**
 * server/config.js
 * Loads config.json, resolves this node's identity, exposes a timestamped logger.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

const NODE_ID = process.argv[2];
const self = config.nodes.find((n) => n.id === NODE_ID);
if (!self) {
  console.error(`Usage: node server/index.js <nodeId>   (one of: ${config.nodes.map((n) => n.id).join(', ')})`);
  process.exit(1);
}
const peers = config.nodes.filter((n) => n.id !== NODE_ID);

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}] [${NODE_ID}]`, ...a);

module.exports = { ROOT, config, NODE_ID, self, peers, log };
