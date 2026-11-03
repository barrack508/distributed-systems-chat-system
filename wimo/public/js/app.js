/**
 * Wimo - Client Application
 * Handles UI rendering, WebSocket connection, failover, and user interactions.
 */
(() => {
  'use strict';

  // ==================== Utilities ====================
  const $ = (id) => document.getElementById(id);
  const COLORS = ['#0a0a0a', '#27272a', '#3f3f46', '#52525b', '#18181b', '#334155', '#44403c', '#404040'];
  const colorOf = (s) => COLORS[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
  const hhmm = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dayLabel = (ts) => {
    const d = new Date(ts), n = new Date();
    return d.toDateString() === n.toDateString() ? 'TODAY' : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  };
  const dmId = (a, b) => 'dm:' + [a, b].sort().join('|');

  // ==================== State ====================
  let nodes = [], urls = [], index = 0, ws = null, user = '', currentNode = null;
  let everConnected = false, closed = false;
  let online = [], known = [];
  const convs = new Map(), seen = new Set();
  let active = 'general', pendingGroup = null, tab = 'all', renderedConv = null, renderedCount = 0;
  const picked = new Set();
  let allGroups = [];
  let myJoinRequests = new Set();
  let creatorRequests = new Map();

  // ==================== UI Helpers ====================
  function avatar(name, size, opts = {}) {
    const el = document.createElement('div');
    el.className = 'av' + (opts.group ? ' group' : '');
    el.style.cssText = `width:${size}px;height:${size}px;background:${opts.general ? '#0a0a0a' : colorOf(name)};font-size:${Math.round(size * .4)}px`;
    el.textContent = opts.general ? '#' : (opts.group ? name.slice(0, 2) : name[0]).toUpperCase();
    if (opts.presence !== undefined) {
      const p = document.createElement('span');
      p.className = 'pres' + (opts.presence ? ' on' : '');
      el.appendChild(p);
    }
    return el;
  }
  const isOnline = (u) => online.includes(u);

  // ==================== Conversations ====================
  function ensureGeneral() {
    if (!convs.has('general')) convs.set('general', { id: 'general', type: 'general', name: 'Workspace', msgs: [], unread: 0, ts: 0 });
  }

  function ensureDm(peer) {
    const id = dmId(user, peer);
    if (!convs.has(id)) convs.set(id, { id, type: 'dm', name: peer, peer, msgs: [], unread: 0, ts: 0 });
    return convs.get(id);
  }

  function ensureGroup(g) {
    const id = 'grp:' + g.id;
    let c = convs.get(id);
    if (!c) {
      c = { id, type: 'group', name: g.name, members: g.members, groupId: g.id, creator: g.creator, msgs: [], unread: 0, ts: g.ts };
      convs.set(id, c);
    } else {
      c.name = g.name;
      c.members = g.members;
    }
    return c;
  }

  function onChat(m, hist) {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    let c;
    if (m.conv === 'general') c = convs.get('general');
    else if (m.conv.startsWith('dm:')) c = ensureDm(m.from === user ? m.to : m.from);
    else c = convs.get(m.conv) || ensureGroup({ id: m.group, name: 'Group', members: [], ts: m.ts });
    const outOfOrder = c.msgs.length && c.msgs[c.msgs.length - 1].ts > m.ts;
    c.msgs.push(m);
    if (outOfOrder) c.msgs.sort((a, b) => a.ts - b.ts);
    c.ts = Math.max(c.ts, m.ts);
    if (!hist && m.from !== user && active !== c.id) c.unread++;
    renderList();
    if (active === c.id) renderChat();
  }

  // ==================== Sidebar Rendering ====================
  function previewOf(c) {
    const m = c.msgs[c.msgs.length - 1];
    if (!m) return c.type === 'dm' ? 'Say hello' : c.type === 'group' ? 'No messages yet' : 'Workspace for everyone';
    const mine = m.from === user;
    return (c.type === 'dm' ? (mine ? 'You: ' : '') : (mine ? 'You: ' : m.from + ': ')) + m.text;
  }

  function convRow(c) {
    const row = document.createElement('div');
    row.className = 'conv-row' + (c.id === active ? ' sel' : '');
    row.appendChild(
      c.type === 'general' ? avatar('Workspace', 42, { general: true }) :
      c.type === 'group' ? avatar(c.name, 42, { group: true }) :
      avatar(c.name, 42, { presence: isOnline(c.peer) })
    );
    const mid = document.createElement('div'); mid.className = 'mid';
    const top = document.createElement('div'); top.className = 'top';
    const nm = document.createElement('span'); nm.className = 'name'; nm.textContent = c.name;
    const tm = document.createElement('span'); tm.className = 'time'; tm.textContent = c.msgs.length ? hhmm(c.ts) : '';
    top.append(nm, tm);
    const bot = document.createElement('div'); bot.className = 'bot';
    const pv = document.createElement('span'); pv.className = 'prev'; pv.textContent = previewOf(c);
    bot.appendChild(pv);
    if (c.unread) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = c.unread; bot.appendChild(b); }
    mid.append(top, bot); row.appendChild(mid);
    row.onclick = () => openConv(c.id);
    return row;
  }

  function personRow(u) {
    const row = document.createElement('div'); row.className = 'conv-row';
    row.appendChild(avatar(u, 42, { presence: isOnline(u) }));
    const mid = document.createElement('div'); mid.className = 'mid';
    const nm = document.createElement('div'); nm.className = 'name'; nm.textContent = u;
    const sb = document.createElement('div'); sb.className = 'prev';
    sb.textContent = isOnline(u) ? 'Online - tap to start a chat' : 'Offline - tap to send a message';
    mid.append(nm, sb); row.appendChild(mid);
    row.onclick = () => { $('search').value = ''; openConv(ensureDm(u).id); };
    return row;
  }

  function renderList() {
    const q = $('search').value.trim().toLowerCase();
    const L = $('list'); L.innerHTML = '';
    let cs = [...convs.values()].sort((a, b) => (a.id === 'general' ? -1 : b.id === 'general' ? 1 : b.ts - a.ts));
    if (tab === 'direct') cs = cs.filter((c) => c.type === 'dm');
    else if (tab === 'groups') cs = cs.filter((c) => c.type !== 'dm');
    if (q) cs = cs.filter((c) => c.name.toLowerCase().includes(q) || (c.members || []).some((m) => m.toLowerCase().includes(q)));

    if (!q) {
      const on = online.filter((u) => u !== user);
      if (on.length && tab !== 'groups') {
        const secDiv = document.createElement('div'); secDiv.className = 'sb-section';
        secDiv.innerHTML = `<span class="sec-label">Online Now</span><span class="sec-badge">${on.length} active</span>`;
        L.appendChild(secDiv);
        const strip = document.createElement('div'); strip.className = 'online-strip';
        on.forEach((u) => {
          const d = document.createElement('div'); d.className = 'u';
          d.append(avatar(u, 40, { presence: true }), Object.assign(document.createElement('span'), { textContent: u.length > 8 ? u.slice(0, 7) + '...' : u }));
          d.onclick = () => openConv(ensureDm(u).id);
          strip.appendChild(d);
        });
        L.appendChild(strip);
      }
      const chatSec = document.createElement('div'); chatSec.className = 'sb-section';
      chatSec.innerHTML = `<span class="sec-label">Conversations</span><span class="sec-link">Sort by recent</span>`;
      L.appendChild(chatSec);
    } else {
      const chatSec = document.createElement('div'); chatSec.className = 'sb-section';
      chatSec.innerHTML = `<span class="sec-label">Conversations</span>`;
      L.appendChild(chatSec);
    }

    cs.forEach((c) => L.appendChild(convRow(c)));

    // Creator pending requests
    convs.forEach((c) => {
      if (c.type === 'group' && c.creator === user) {
        const reqs = creatorRequests.get(c.groupId) || [];
        if (reqs.length) {
          const secDiv = document.createElement('div'); secDiv.className = 'sb-section';
          secDiv.innerHTML = `<span class="sec-label">Join Requests - ${c.name}</span>`;
          L.appendChild(secDiv);
          reqs.forEach(r => {
            const row = document.createElement('div'); row.className = 'conv-row';
            row.appendChild(avatar(r.user, 36, { presence: isOnline(r.user) }));
            const mid = document.createElement('div'); mid.className = 'mid';
            const nm = document.createElement('div'); nm.className = 'name'; nm.textContent = r.user;
            mid.appendChild(nm); row.appendChild(mid);
            const actions = document.createElement('div'); actions.style.cssText = 'display:flex;gap:6px';
            const approveBtn = document.createElement('button'); approveBtn.textContent = 'Approve'; approveBtn.className = 'join-approve-btn';
            approveBtn.onclick = (e) => { e.stopPropagation(); ws.send(JSON.stringify({ type: 'group-approve', group: c.groupId, requestUser: r.user })); };
            const rejectBtn = document.createElement('button'); rejectBtn.textContent = 'Reject'; rejectBtn.className = 'join-reject-btn';
            rejectBtn.onclick = (e) => { e.stopPropagation(); ws.send(JSON.stringify({ type: 'group-reject', group: c.groupId, requestUser: r.user })); };
            actions.append(approveBtn, rejectBtn); row.appendChild(actions);
            L.appendChild(row);
          });
        }
      }
    });

    // Discoverable groups
    const myGroupIds = new Set([...convs.values()].filter(c => c.type === 'group').map(c => c.groupId));
    const discoverable = allGroups.filter(g => !myGroupIds.has(g.id));
    if (discoverable.length && tab !== 'direct') {
      const discSec = document.createElement('div'); discSec.className = 'sb-section';
      discSec.innerHTML = `<span class="sec-label">Discover Channels</span>`;
      L.appendChild(discSec);
      discoverable.forEach(g => {
        const row = document.createElement('div'); row.className = 'conv-row';
        row.appendChild(avatar(g.name, 42, { group: true }));
        const mid = document.createElement('div'); mid.className = 'mid';
        const top = document.createElement('div'); top.className = 'top';
        const nm = document.createElement('span'); nm.className = 'name'; nm.textContent = g.name;
        top.appendChild(nm);
        const bot = document.createElement('div'); bot.className = 'bot';
        const pv = document.createElement('span'); pv.className = 'prev'; pv.textContent = `${g.members.length} members`;
        bot.appendChild(pv); mid.append(top, bot); row.appendChild(mid);
        const btn = document.createElement('button');
        if (myJoinRequests.has(g.id)) { btn.textContent = 'Pending'; btn.className = 'join-pending-btn'; btn.disabled = true; }
        else { btn.textContent = 'Request to Join'; btn.className = 'join-request-btn'; btn.onclick = (e) => { e.stopPropagation(); ws.send(JSON.stringify({ type: 'group-request', group: g.id })); }; }
        row.appendChild(btn);
        L.appendChild(row);
      });
    }

    // Search results: people
    if (q) {
      const people = known.filter((u) => u !== user && u.toLowerCase().includes(q));
      const pSec = document.createElement('div'); pSec.className = 'sb-section';
      pSec.innerHTML = `<span class="sec-label">People</span>`;
      L.appendChild(pSec);
      if (people.length) people.forEach((u) => L.appendChild(personRow(u)));
      else { const e = document.createElement('div'); e.style.cssText = 'color:var(--muted);font-size:13px;padding:10px'; e.textContent = 'No one with that name has joined Wimo yet.'; L.appendChild(e); }
    }
  }

  // ==================== Chat Rendering ====================
  function renderHeader() {
    const c = convs.get(active); if (!c) return;
    $('hAv').replaceChildren(
      c.type === 'general' ? avatar('Workspace', 38, { general: true }) :
      c.type === 'group' ? avatar(c.name, 38, { group: true }) :
      avatar(c.name, 38, { presence: isOnline(c.peer) })
    );
    const titleEl = $('hTitle'); titleEl.innerHTML = '';
    titleEl.append(Object.assign(document.createElement('span'), { textContent: c.name }));
    if (c.type === 'group') { const badge = document.createElement('span'); badge.className = 'priv-badge'; badge.textContent = 'Private'; titleEl.appendChild(badge); }
    $('hSub').textContent = c.type === 'dm'
      ? (isOnline(c.peer) ? 'Online' : 'Offline - messages are delivered when they return')
      : c.type === 'group'
        ? `${c.members.length} members: ${c.members.map((m) => (m === user ? 'You' : m)).join(', ')}`
        : `${online.length} online - everyone can read this room`;
    $('text').placeholder = c.type === 'general' ? 'Message Workspace... (Markdown supported)' : `Message ${c.name}... (Markdown supported)`;
  }

  function renderChat() {
    const c = convs.get(active); if (!c) return;
    renderHeader();
    const M = $('messages'); M.innerHTML = '';
    if (!c.msgs.length) {
      const h = document.createElement('div'); h.className = 'hello';
      h.textContent = c.type === 'dm' ? `This is the start of your chat with ${c.name}. Say hello!`
        : c.type === 'group' ? 'The group is ready. Send the first message.'
        : 'Welcome to the Workspace. Messages here are visible to everyone.';
      M.appendChild(h);
    }
    const fresh = renderedConv === c.id ? renderedCount : Infinity;
    let prev = null;
    c.msgs.forEach((m, i) => {
      if (!prev || new Date(prev.ts).toDateString() !== new Date(m.ts).toDateString()) {
        const d = document.createElement('div'); d.className = 'day-divider';
        d.innerHTML = `<span>${dayLabel(m.ts)}</span>`; M.appendChild(d); prev = null;
      }
      const mine = m.from === user;
      const first = !prev || prev.from !== m.from || m.ts - prev.ts > 300000;
      const el = document.createElement('div');
      el.className = 'msg' + (mine ? ' mine' : '') + (i >= fresh ? ' new' : '');

      if (!mine) {
        const avEl = avatar(m.from, 36, {}); avEl.className += ' msg-avatar';
        el.appendChild(avEl);
      }

      const content = document.createElement('div'); content.className = 'msg-content';

      if (!mine && first) {
        const meta = document.createElement('div'); meta.className = 'msg-meta';
        meta.innerHTML = `<span class="sender">${m.from}</span><span class="time">${hhmm(m.ts)}</span>`;
        content.appendChild(meta);
      }

      const b = document.createElement('div'); b.className = 'msg-bubble'; b.textContent = m.text;
      content.appendChild(b);

      if (mine && first) {
        const meta = document.createElement('div'); meta.className = 'msg-meta';
        meta.innerHTML = `<span class="time">${hhmm(m.ts)}</span><span class="sender">You</span>`;
        content.appendChild(meta);
      }

      if (m.reactions && m.reactions.length) {
        const rxDiv = document.createElement('div'); rxDiv.className = 'reactions';
        m.reactions.forEach(r => { const s = document.createElement('span'); s.className = 'rx'; s.textContent = r.emoji + ' ' + r.count; rxDiv.appendChild(s); });
        content.appendChild(rxDiv);
      }

      if (mine) { const check = document.createElement('span'); check.className = 'msg-check'; check.textContent = '\u2713'; content.appendChild(check); }

      el.appendChild(content); M.appendChild(el); prev = m;
    });
    renderedConv = c.id; renderedCount = c.msgs.length;
    M.scrollTop = M.scrollHeight;
  }

  function openConv(id) {
    active = id;
    const c = convs.get(id); c.unread = 0;
    $('layout').classList.add('chat-open');
    renderList(); renderChat(); $('text').focus();
  }

  // ==================== Cluster / Nodes ====================
  const nodeState = {};
  const hostOf = (n) => (['localhost', '127.0.0.1'].includes(n.host) ? location.hostname : n.host);

  async function pollNodes() {
    await Promise.all(nodes.map(async (n) => {
      try { nodeState[n.id] = await (await fetch(`http://${hostOf(n)}:${n.port}/api/status`, { cache: 'no-store' })).json(); }
      catch { nodeState[n.id] = null; }
    }));
    renderNodes();
  }

  function renderNodes() {
    $('nodes').innerHTML = '';
    nodes.forEach((n) => {
      const p = document.createElement('span');
      p.className = 'pill' + (n.id === currentNode ? ' cur' : '');
      p.title = nodeState[n.id] ? `${nodeState[n.id].localClients} client(s) connected` : 'down';
      p.innerHTML = `<span class="dot ${nodeState[n.id] ? 'up' : ''}"></span>${n.id}`;
      $('nodes').appendChild(p);
    });
  }

  async function loadCluster() {
    try {
      const d = await (await fetch('/api/nodes')).json();
      nodes = d.nodes;
      urls = nodes.map((n) => `ws://${hostOf(n)}:${n.port}/chat`);
      index = Math.max(0, nodes.findIndex((n) => n.id === d.self));
      renderNodes(); pollNodes(); setInterval(pollNodes, 3000);
    } catch { $('loginErr').textContent = 'Cannot reach the server.'; }
  }

  // ==================== Connection & Failover ====================
  function setStatus(text, ok) { $('sendBtn').disabled = !ok; }
  function banner(text, kind) { const b = $('banner'); b.textContent = text; b.className = kind; }

  function connect() {
    if (closed) return;
    setStatus('Connecting...', false);
    ws = new WebSocket(urls[index % urls.length]);
    const timer = setTimeout(() => ws.close(), 3000);
    ws.onopen = () => { clearTimeout(timer); ws.send(JSON.stringify({ type: 'join', user })); };
    ws.onmessage = (e) => handle(JSON.parse(e.data));
    ws.onclose = () => {
      clearTimeout(timer); if (closed) return;
      if (currentNode) banner(`Lost connection to ${currentNode}. Switching to another server...`, 'warn');
      currentNode = null; setStatus('Reconnecting...', false); renderNodes(); pollNodes();
      index++; setTimeout(connect, 1000);
    };
  }

  function handle(m) {
    if (m.type === 'welcome') {
      const re = everConnected; everConnected = true; currentNode = m.node;
      online = m.online; known = m.known;
      $('login').style.display = 'none'; $('app').style.display = 'block';
      $('meBox').innerHTML = '';
      $('meBox').append(avatar(user, 28, {}), Object.assign(document.createElement('span'), { innerHTML: 'Signed in as <b></b>' }));
      $('meBox').querySelector('b').textContent = user;
      const settingsBtn = document.createElement('button'); settingsBtn.className = 'settings-btn'; settingsBtn.innerHTML = '&#x2699;'; $('meBox').appendChild(settingsBtn);
      ensureGeneral(); m.groups.forEach(ensureGroup); m.history.forEach((h) => onChat(h, true));
      allGroups = m.allGroups || [];
      (m.pendingRequests || []).forEach(gid => myJoinRequests.add(gid));
      allGroups.filter(g => g.creator === user).forEach(g => {
        if (!creatorRequests.has(g.id)) creatorRequests.set(g.id, []);
      });
      setStatus(`Connected: ${m.node}`, true);
      if (re) { banner(`Reconnected automatically to ${m.node}.`, 'ok'); setTimeout(() => (($('banner').className = '')), 4000); }
      else $('banner').className = '';
      renderNodes(); pollNodes(); renderList(); renderChat();
    } else if (m.type === 'chat') onChat(m, false);
    else if (m.type === 'group') {
      const c = ensureGroup(m.group);
      if (!allGroups.find(g => g.id === m.group.id)) allGroups.push(m.group);
      else { const idx = allGroups.findIndex(g => g.id === m.group.id); allGroups[idx] = m.group; }
      if (pendingGroup && m.group.creator === user && m.group.name === pendingGroup) {
        pendingGroup = null; $('modal').classList.remove('open'); openConv(c.id);
      } else renderList();
    } else if (m.type === 'users') {
      online = m.online; known = m.known; renderList(); renderHeader();
      if ($('modal').classList.contains('open')) renderPicker();
    } else if (m.type === 'join-request') {
      if (!creatorRequests.has(m.group.id)) creatorRequests.set(m.group.id, []);
      creatorRequests.get(m.group.id).push({ user: m.user, ts: m.ts });
      banner(`${m.user} wants to join "${m.group.name}"`, 'ok'); renderList();
    } else if (m.type === 'request-sent') {
      myJoinRequests.add(m.group); banner('Join request sent! Waiting for approval...', 'ok'); renderList();
    } else if (m.type === 'request-approved') {
      banner(`${m.user} was approved into your group.`, 'ok');
      const reqs = creatorRequests.get(m.group) || [];
      const idx = reqs.findIndex(r => r.user === m.user);
      if (idx !== -1) reqs.splice(idx, 1); renderList();
    } else if (m.type === 'request-rejected') {
      const reqs = creatorRequests.get(m.group) || [];
      const idx = reqs.findIndex(r => r.user === m.user);
      if (idx !== -1) reqs.splice(idx, 1); renderList();
    } else if (m.type === 'error') {
      if (m.fatal && !everConnected) { closed = true; $('loginErr').textContent = m.text; ws.close(); }
      else { banner(m.text, 'warn'); setTimeout(() => ($('banner').className = ''), 3500); }
    }
  }

  // ==================== Group Modal ====================
  function renderPicker() {
    const q = $('gSearch').value.trim().toLowerCase();
    const chips = $('gChips'); chips.innerHTML = '';
    picked.forEach((u) => {
      const c = document.createElement('span'); c.className = 'chip'; c.append(u);
      const x = document.createElement('button'); x.type = 'button'; x.textContent = 'x';
      x.onclick = () => { picked.delete(u); renderPicker(); };
      c.appendChild(x); chips.appendChild(c);
    });
    const P = $('gPick'); P.innerHTML = '';
    const people = known.filter((u) => u !== user && u.toLowerCase().includes(q));
    if (!people.length) {
      const e = document.createElement('div'); e.style.cssText = 'color:var(--muted);font-size:13px;padding:10px';
      e.textContent = known.length <= 1 ? 'No other users have joined yet.' : 'No matches.'; P.appendChild(e);
    }
    people.forEach((u) => {
      const row = document.createElement('div'); row.className = 'row' + (picked.has(u) ? ' on' : '');
      const box = document.createElement('span'); box.className = 'box'; box.textContent = picked.has(u) ? '\u2713' : '';
      const mid = document.createElement('div'); mid.style.flex = '1'; mid.style.minWidth = '0';
      mid.innerHTML = '<div style="font-weight:600;font-size:13px"></div>'; mid.firstChild.textContent = u;
      row.append(avatar(u, 34, { presence: isOnline(u) }), mid, box);
      row.onclick = () => { picked.has(u) ? picked.delete(u) : picked.add(u); renderPicker(); };
      P.appendChild(row);
    });
    $('gCreate').disabled = !($('gName').value.trim() && picked.size);
  }

  function openModal() {
    picked.clear(); $('gName').value = ''; $('gSearch').value = '';
    $('modal').classList.add('open'); renderPicker(); $('gName').focus();
  }

  // ==================== Events ====================
  function join() {
    const v = $('name').value.trim();
    if (!/^[\w.-]{2,20}$/.test(v)) { $('loginErr').textContent = 'Use 2-20 characters: letters, digits, _ . -'; return; }
    user = v; closed = false; $('loginErr').textContent = ''; connect();
  }

  $('joinBtn').onclick = join;
  $('name').addEventListener('keydown', (e) => e.key === 'Enter' && join());
  $('search').addEventListener('input', renderList);
  $('newGroupBtn').onclick = openModal;
  $('gCancel').onclick = () => $('modal').classList.remove('open');
  $('modal').addEventListener('mousedown', (e) => e.target === $('modal') && $('modal').classList.remove('open'));
  $('gName').addEventListener('input', renderPicker);
  $('gSearch').addEventListener('input', renderPicker);
  $('gCreate').onclick = () => {
    const name = $('gName').value.trim();
    if (!name || !picked.size || !ws || ws.readyState !== 1) return;
    pendingGroup = name; ws.send(JSON.stringify({ type: 'group-create', name, members: [...picked] }));
  };
  $('backBtn').onclick = () => $('layout').classList.remove('chat-open');

  const sendMsg = () => {
    const text = $('text').value.trim(), c = convs.get(active);
    if (!text || !c || !ws || ws.readyState !== 1 || !currentNode) return;
    ws.send(JSON.stringify(
      c.type === 'general' ? { type: 'chat', text } :
      c.type === 'dm' ? { type: 'dm', to: c.peer, text } :
      { type: 'gchat', group: c.groupId, text }
    ));
    $('text').value = '';
  };
  $('sendBtn').onclick = sendMsg;
  $('text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); } });

  document.querySelectorAll('.sb-tabs button').forEach((b) => (b.onclick = () => {
    tab = b.dataset.tab;
    document.querySelectorAll('.sb-tabs button').forEach((x) => x.classList.toggle('on', x === b));
    renderList();
  }));

  // ==================== Init ====================
  loadCluster();
})();
