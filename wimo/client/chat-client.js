/**
 * Wimo ChatClient - reusable client with automatic FAILOVER.
 * Used by the CLI, the load test and the failover test.
 *
 * It is given a list of server URLs. It connects to the first one that answers;
 * if the connection drops (server crash, network loss) it moves on to the next
 * server in the list and re-joins automatically with the same username.
 * Messages are de-duplicated by id, so history replays after a reconnect
 * never show the same message twice.
 */
const EventEmitter = require('events');
const WebSocket = require('ws');

class ChatClient extends EventEmitter {
  constructor({ urls, user, retryMs = 1000, connectTimeoutMs = 3000 }) {
    super();
    this.urls = urls;
    this.user = user;
    this.retryMs = retryMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.index = Math.floor(Math.random() * urls.length); // spread clients over nodes
    this.seen = new Set();
    this.online = []; this.known = []; this.groups = new Map();
    this.closedByUser = false;
    this.everConnected = false;
    this.node = null;
  }

  connect() {
    if (this.closedByUser) return;
    const url = this.urls[this.index % this.urls.length];
    const ws = new WebSocket(url);
    this.ws = ws;
    const timer = setTimeout(() => ws.terminate(), this.connectTimeoutMs);

    ws.on('open', () => {
      clearTimeout(timer);
      ws.send(JSON.stringify({ type: 'join', user: this.user }));
    });

    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'welcome') {
        const reconnect = this.everConnected;
        this.everConnected = true;
        this.node = m.node;
        this.online = m.online; this.known = m.known;
        this.groups = new Map(m.groups.map((g) => [g.id, g]));
        this.emit('connected', { node: m.node, reconnect, online: m.online, known: m.known, groups: m.groups });
        m.history.forEach((h) => this._chat(h, true));
      } else if (m.type === 'chat') this._chat(m, false);
      else if (m.type === 'group') { this.groups.set(m.group.id, m.group); this.emit('group', m.group); }
      else if (m.type === 'users') { this.online = m.online; this.known = m.known; this.emit('users', m); }
      else if (m.type === 'error') {
        if (m.fatal && !this.everConnected) { this.closedByUser = true; this.emit('fatal', m.text); }
        else this.emit('server-error', m.text);
      }
    });

    ws.on('close', () => {
      clearTimeout(timer);
      if (this.closedByUser) return;
      if (this.node) this.emit('disconnected', { node: this.node });
      this.node = null;
      this.index++; // FAILOVER: try the next server in the list
      setTimeout(() => this.connect(), this.retryMs);
    });
    ws.on('error', () => {});
  }

  _chat(m, isHistory) {
    if (this.seen.has(m.id)) return;
    this.seen.add(m.id);
    this.emit('chat', { ...m, isHistory });
  }

  get connected() { return this.ws && this.ws.readyState === WebSocket.OPEN && !!this.node; }
  say(text) { return this._send({ type: 'chat', text }); }
  /** Send a one-to-one message (the other user may be offline). */
  dm(to, text) { return this._send({ type: 'dm', to, text }); }
  whisper(to, text) { return this.dm(to, text); }
  /** Send a message to a group you belong to. */
  groupSay(group, text) { return this._send({ type: 'gchat', group, text }); }
  createGroup(name, members) { return this._send({ type: 'group-create', name, members }); }
  _send(obj) { if (this.connected) this.ws.send(JSON.stringify(obj)); return this.connected; }
  close() { this.closedByUser = true; if (this.ws) this.ws.close(); }
}

module.exports = ChatClient;
