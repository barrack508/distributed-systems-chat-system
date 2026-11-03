/**
 * server/log.js
 * Replicated log: persistence, de-duplicated application of entries, and
 * visibility rules for filtering history per user.
 */
const fs = require('fs');
const path = require('path');
const { ROOT, NODE_ID, log } = require('./config');
const state = require('./state');

const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const LOG_FILE = path.join(DATA_DIR, `${NODE_ID}.log`);

/** Add an entry to memory if new. Returns true when it was new. */
function apply(e) {
  if (!e || !e.id || state.seen.has(e.id)) return false;
  state.seen.add(e.id);
  state.entries.push(e);
  if (state.entries.length > 1 && state.entries[state.entries.length - 2].ts > e.ts) {
    state.entries.sort((a, b) => a.ts - b.ts);
  }
  if (e.t === 'group') state.groups.set(e.id, e);
  else if (e.t === 'user') state.known.add(e.name);
  return true;
}

const persist = (e) => fs.appendFile(LOG_FILE, JSON.stringify(e) + '\n', () => {});

function loadLog() {
  if (!fs.existsSync(LOG_FILE)) return;
  for (const line of fs.readFileSync(LOG_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (!e.t) { e.t = 'msg'; e.conv = e.conv || 'general'; }
      apply(e);
    } catch { /* ignore a half-written last line after a crash */ }
  }
  log(`recovered ${state.entries.length} entries from ${path.basename(LOG_FILE)}`);
}

const lastTs = () => (state.entries.length ? state.entries[state.entries.length - 1].ts : 0);

/** May this user see this entry? */
function visibleTo(user, e) {
  if (e.t !== 'msg') return false;
  if (e.conv === 'general') return true;
  if (e.conv.startsWith('dm:')) return e.from === user || e.to === user;
  const g = state.groups.get(e.group);
  return !!g && g.members.includes(user);
}

loadLog();

module.exports = { apply, persist, lastTs, visibleTo };
