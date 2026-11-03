/**
 * Automated functional + failover test.
 * Starts 3 server nodes as child processes, then checks:
 *   1. clients on DIFFERENT nodes receive each other's broadcasts
 *   2. one-to-one messages, groups, and messages to OFFLINE users work across nodes
 *   3. when a node is KILLED its clients reconnect to another node automatically
 *   4. chat keeps working after the failover
 *   5. a restarted node recovers its log and re-syncs messages it missed
 * Run:  npm test
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ChatClient = require('../client/chat-client');
const config = require('../config.json');

const ROOT = path.join(__dirname, '..');
const url = (id) => { const n = config.nodes.find((x) => x.id === id); return `ws://${n.host}:${n.port}/chat`; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = {};
let passed = 0, failed = 0;

function startNode(id) {
  procs[id] = spawn('node', [path.join(ROOT, 'server', 'index.js'), id], { stdio: 'ignore' });
}
function check(name, ok) { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`); ok ? passed++ : failed++; }
async function until(fn, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(100); } return false; }

function makeClient(user, firstNode) {
  const order = [firstNode, ...config.nodes.map((n) => n.id).filter((i) => i !== firstNode)];
  const c = new ChatClient({ urls: order.map(url), user, retryMs: 300 });
  c.index = 0; c.got = []; c.priv = []; c.grp = [];
  c.on('chat', (m) => {
    if (m.isHistory) return;
    (m.conv === 'general' ? c.got : m.conv.startsWith('dm:') ? c.priv : c.grp).push(m.text);
  });
  c.connect();
  return c;
}

(async () => {
  config.nodes.forEach((n) => { try { fs.unlinkSync(path.join(ROOT, 'data', `${n.id}.log`)); } catch {} });
  config.nodes.forEach((n) => startNode(n.id));
  await sleep(1500);

  console.log('\n1. Cross-node broadcast');
  const alice = makeClient('alice', 'node1');
  const bob = makeClient('bob', 'node2');
  const carol = makeClient('carol', 'node3');
  await until(() => alice.connected && bob.connected && carol.connected);
  check('three clients connected to three different nodes', alice.node === 'node1' && bob.node === 'node2' && carol.node === 'node3');
  await sleep(500);
  alice.say('hello from alice');
  check('bob (node2) received alice (node1) message', await until(() => bob.got.includes('hello from alice')));
  check('carol (node3) received alice (node1) message', await until(() => carol.got.includes('hello from alice')));

  console.log('\n2. Private messaging across nodes');
  bob.whisper('carol', 'secret for carol');
  check('carol received the private message', await until(() => carol.priv.includes('secret for carol')));
  await sleep(300);
  check('alice did NOT see the private message', !alice.priv.includes('secret for carol'));

  console.log('\n2b. Groups and messages to offline users');
  alice.createGroup('team', ['bob', 'carol']);
  check('bob and carol were added to the group', await until(() => bob.groups.size === 1 && carol.groups.size === 1));
  const gid = [...alice.groups.keys()][0];
  bob.groupSay(gid, 'group hello');
  check('group message reached alice (node1) and carol (node3)', await until(() => alice.grp.includes('group hello') && carol.grp.includes('group hello')));
  const zed = makeClient('zed', 'node2');
  await until(() => zed.connected);
  zed.close();
  await sleep(600);
  alice.dm('zed', 'are you there zed?');
  await sleep(600);
  const zed2 = makeClient('zed', 'node3');
  const zedHistory = [];
  zed2.on('chat', (m) => m.isHistory && zedHistory.push(m.text));
  await until(() => zed2.connected);
  await sleep(300);
  check('offline user got the DM in history on reconnecting (via a different node)', zedHistory.includes('are you there zed?'));
  zed2.close();

  console.log('\n3. Failover: killing node1');
  procs.node1.kill('SIGKILL');
  check('alice reconnected to a surviving node', await until(() => alice.connected && alice.node !== 'node1'));
  await sleep(800);
  bob.say('are you still there alice?');
  check('alice receives messages after failover', await until(() => alice.got.includes('are you still there alice?')));
  bob.groupSay(gid, 'group still works');
  check('group chat works after failover', await until(() => alice.grp.includes('group still works')));
  alice.say('yes, I failed over');
  check('bob receives alice message after failover', await until(() => bob.got.includes('yes, I failed over')));

  console.log('\n4. Recovery: restarting node1 (log recovery + peer re-sync)');
  bob.say('sent while node1 was down');
  await sleep(500);
  startNode('node1');
  await sleep(3500);
  const dave = makeClient('dave', 'node1');
  const history = [];
  dave.on('chat', (m) => m.isHistory && history.push(m.text));
  await until(() => dave.connected && dave.node === 'node1');
  await sleep(400);
  check('restarted node1 recovered earlier messages from its log', history.includes('hello from alice'));
  check('restarted node1 re-synced the message it missed while down', history.includes('sent while node1 was down'));
  check('non-member dave cannot see group or private messages', !history.includes('group hello') && !history.includes('secret for carol'));

  [alice, bob, carol, dave].forEach((c) => c.close());
  Object.values(procs).forEach((p) => p.kill());
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
