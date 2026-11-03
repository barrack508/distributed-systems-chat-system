# distributed-systems-chat-system
Assignment
Wimo - Distributed Chat Application

A real-time chat system that runs on a cluster of **three server nodes** (any two are enough). Clients can connect to any node and still talk to users on the other nodes. If a node crashes, its clients reconnect to another node automatically, and no message is lost.

Built with Node.js and WebSockets (one dependency: `ws`).

**Group members:** (add admission numbers and names here)

## Features

| Requirement | How it is met |
|---|---|
| Multiple server nodes | 3 nodes in a full mesh, defined in `config.json` |
| Multiple simultaneous clients | Asynchronous (event-driven) I/O in Node.js, tested with 100 clients |
| Broadcast to all clients | A message is delivered to local clients and relayed to the other nodes |
| Failover | Clients hold a list of servers and move to the next one when a connection drops |
| Message persistence | Each node appends every message to `data/<node>.log` and re-syncs missed messages from peers on restart |
| Client interface | Web UI (served by each node) and a command-line client |
| Extras | User search, one-to-one chats (also to offline users), group chats, unread badges, online status, cluster status panel, heartbeat |

 **Project structure**

```
wimo/
  config.json              cluster definition (node ids, hosts, ports)

  server/                  Node.js backend, split into focused modules
    index.js               entry point: wires HTTP + WS + peers + heartbeat
    config.js              loads config.json, resolves NODE_ID, logger
    state.js               shared Maps/Sets and low-level send helpers
    log.js                 replicated log (apply, persist, loadLog, visibleTo)
    peers.js               full-mesh peer links, handshake, sync
    chat.js                deliver, publish, handleClientMessage
    http.js                HTTP server (static files + /api/nodes, /api/status)

  client/
    chat-client.js         reusable client library with failover
    cli.js                 command-line client

  public/                  web UI served by every node
    index.html             HTML markup only
    css/styles.css         all styles, organized by component
    js/app.js              client logic (WebSocket, rendering, failover)
    favicon.svg            brand icon

  test/
    failover-test.js       automated functional + failover test
    load-test.js           load test

  data/                    per-node message logs (created automatically)
  docs/                    UI screenshots referenced from README
  start-all.sh / stop-all.sh
                           start or stop the 3 nodes (Linux/macOS/Git Bash)
```

**Setup**

Requires Node.js 18 or newer.

```bash
npm install
```

**Run**

Start each node in its own terminal:

```bash
npm run node1      # http://localhost:3001
npm run node2      # http://localhost:3002
npm run node3      # http://localhost:3003
```

(or run `./start-all.sh` to start all three at once.)

## User guide

**Web UI**
1. Open `http://localhost:3001` in a browser (use `3002` and `3003` for other users).
2. Enter a username (2-20 characters) and click **Join Wimo**.
3. **Workspace** is the public room: everyone sees these messages.
4. **Start a private chat:** type a name in the search box and tap the person (or tap someone in *Online now*). Offline users also appear in search, and they receive your messages when they return.
5. **Create a group:** tap the **+** button, name the group, search and tick the people to add, then click **Create group**. Only members can see the group.
6. Chats show unread counts, and the green dot shows who is online.
7. The *Nodes* pills at the bottom show which servers are up and which one you are connected to.

**Command-line client**

```bash
npm run client -- alice
```
Commands: `/w <user> <text>` private message, `/newgroup <name> <user1> <user2>...` create a group, `/g <group> <text>` message a group, `/users`, `/groups`, `/quit`.

**Testing**

```bash
npm test                       # starts its own 3 nodes; checks broadcast, private chats, groups, offline delivery, failover, recovery
./start-all.sh                 # (nodes must be running for the load test)
npm run load -- 100 10         # 100 clients x 10 messages each
```

**Manual failover demo:** connect two browsers to different nodes, stop the node one of them is using (`Ctrl+C` in its terminal). The browser shows "Lost connection", then "Reconnected automatically", and chat continues. Restart the node and it re-syncs the messages it missed.

**Running on several computers**

Edit `config.json` and replace `localhost` with each machine's IP address, run one node per machine, and open the UI using any node's address.

**How it works (short)**

- **Clients <-> node:** WebSocket at `/chat`. Messages are JSON (`join`, `chat`, `dm`, `gchat`, `group-create`).
- **Node <-> node:** WebSocket at `/peer`. A node dials only peers with a larger id, so there is exactly one link per pair. Public messages carry a unique id so duplicates are ignored.
- **Replicated log:** messages, groups and registered users are all log *entries* with a unique id. Every node relays each entry to the others and stores all of them in `data/<node>.log`, so any node can show any user's history after a failover. A user only receives entries they are allowed to see (General, their own private chats, their groups).
- **Presence:** every node tells its peers which users are connected to it, so each node knows who is online everywhere and usernames stay unique while online.
- **Recovery:** when two nodes link up they exchange `since <last timestamp>` and send each other whatever the other missed.
