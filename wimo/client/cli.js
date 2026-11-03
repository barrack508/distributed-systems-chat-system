/**
 * Wimo command-line client with automatic failover.
 * Usage:  node client/cli.js <username> [ws://host:port/chat ...]
 * With no URLs given it uses every node listed in config.json.
 */
const readline = require('readline');
const path = require('path');
const ChatClient = require('./chat-client');
const config = require(path.join(__dirname, '..', 'config.json'));

const user = process.argv[2];
if (!user) { console.error('Usage: node client/cli.js <username> [server urls...]'); process.exit(1); }
const urls = process.argv.length > 3
  ? process.argv.slice(3)
  : config.nodes.map((n) => `ws://${n.host}:${n.port}/chat`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${user}> ` });
const print = (line) => { readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0); console.log(line); rl.prompt(true); };
const time = (ts) => new Date(ts).toLocaleTimeString();

const client = new ChatClient({ urls, user });
const groupByName = (n) => [...client.groups.values()].find((g) => g.name.toLowerCase() === n.toLowerCase());

client.on('connected', ({ node, reconnect, online, known }) => {
  print(`*** ${reconnect ? 'RECONNECTED' : 'Connected'} to ${node}. Online: ${online.join(', ')}  (known users: ${known.length})`);
  if (!reconnect) print('*** /w <user> <text> | /newgroup <name> <user1> <user2>... | /g <group> <text> | /users | /groups | /quit');
});
client.on('disconnected', ({ node }) => print(`*** Lost connection to ${node}. Trying another server...`));
client.on('chat', (m) => {
  const h = m.isHistory ? '(history) ' : '';
  let where = '';
  if (m.conv.startsWith('dm:')) where = `(private ${m.from} -> ${m.to}) `;
  else if (m.conv.startsWith('grp:')) where = `[${(client.groups.get(m.group) || {}).name || 'group'}] `;
  print(`${h}[${time(m.ts)}] ${where}${m.from}: ${m.text}`);
});
client.on('group', (g) => print(`*** You were added to group "${g.name}" (members: ${g.members.join(', ')})`));
client.on('server-error', (t) => print(`!!! ${t}`));
client.on('fatal', (t) => { console.error(`!!! ${t}`); process.exit(1); });

rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return rl.prompt();
  const [cmd, ...a] = text.split(' ');
  let ok = true;
  if (cmd === '/quit') { client.close(); return process.exit(0); }
  else if (cmd === '/users') print(`*** Online: ${client.online.join(', ')}\n*** Known: ${client.known.join(', ')}`);
  else if (cmd === '/groups') print(`*** Groups: ${[...client.groups.values()].map((g) => `${g.name} (${g.members.join(', ')})`).join('; ') || 'none'}`);
  else if (cmd === '/w') ok = client.dm(a[0], a.slice(1).join(' '));
  else if (cmd === '/newgroup') ok = client.createGroup(a[0], a.slice(1));
  else if (cmd === '/g') {
    const g = groupByName(a[0] || '');
    if (!g) print('!!! No such group. Use /groups'); else ok = client.groupSay(g.id, a.slice(1).join(' '));
  } else ok = client.say(text);
  if (!ok) print('!!! Not connected right now - message not sent');
  rl.prompt();
});
rl.on('close', () => process.exit(0));

client.connect();
rl.prompt();
