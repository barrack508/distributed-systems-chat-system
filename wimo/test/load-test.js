/**
 * Load test: N clients spread over all nodes, each sending M messages at once.
 * Every message must reach every client, so expected deliveries = N * M * N.
 * Usage:  node test/load-test.js [clients=30] [messagesPerClient=10]
 * (the server nodes must already be running)
 */
const ChatClient = require('../client/chat-client');
const config = require('../config.json');

const N = parseInt(process.argv[2] || '30', 10);
const M = parseInt(process.argv[3] || '10', 10);
const urls = config.nodes.map((n) => `ws://${n.host}:${n.port}/chat`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const run = Date.now().toString(36);
  const clients = []; let received = 0; const latencies = [];
  for (let i = 0; i < N; i++) {
    const c = new ChatClient({ urls, user: `lt${run}_${i}` });
    c.index = i % urls.length; // round-robin over the nodes
    c.on('chat', (m) => {
      if (m.isHistory || !m.text.startsWith('LT|')) return;
      received++; latencies.push(Date.now() - Number(m.text.split('|')[1]));
    });
    clients.push(c); c.connect();
  }
  while (clients.some((c) => !c.connected)) await sleep(50);
  await sleep(1000);
  console.log(`${N} clients connected across ${urls.length} nodes. Sending ${N * M} messages simultaneously...`);

  const t0 = Date.now();
  for (let k = 0; k < M; k++) clients.forEach((c) => c.say(`LT|${Date.now()}|${c.user}|${k}`));
  const expected = N * M * N;
  while (received < expected && Date.now() - t0 < 30000) await sleep(50);
  const dt = (Date.now() - t0) / 1000;

  latencies.sort((a, b) => a - b);
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))];
  console.log(`\nMessages sent        : ${N * M}`);
  console.log(`Deliveries expected  : ${expected}`);
  console.log(`Deliveries received  : ${received}  (${((received / expected) * 100).toFixed(1)}%)`);
  console.log(`Total time           : ${dt.toFixed(2)} s`);
  console.log(`Throughput           : ${Math.round(received / dt)} deliveries/s`);
  console.log(`Latency avg / p95 / max : ${Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)} / ${pct(0.95)} / ${latencies[latencies.length - 1]} ms`);
  clients.forEach((c) => c.close());
  process.exit(received === expected ? 0 : 1);
})();
