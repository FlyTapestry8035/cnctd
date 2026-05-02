'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MAX_USERS_PER_SESSION = 2000;
const MAX_MESSAGES_RETAINED = 500;
const MAX_MESSAGES_ON_JOIN = 100;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_NAME_LENGTH = 40;
const MAX_MARKDOWN_LENGTH = 200_000;
const SESSION_IDLE_TTL_MS = 24 * 60 * 60 * 1000;
const HEARTBEAT_MS = 30_000;

const sessions = new Map();

function genSessionId() {
  // 12-char URL-safe id; collision check below
  return crypto.randomBytes(9).toString('base64url').slice(0, 12);
}

function genId(bytes = 8) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function pickColor(seed) {
  const hash = crypto.createHash('sha1').update(seed).digest();
  const hue = hash[0] * 360 / 256;
  return `hsl(${hue.toFixed(0)}, 70%, 55%)`;
}

function createSession() {
  let id;
  do { id = genSessionId(); } while (sessions.has(id));
  const session = {
    id,
    users: new Map(),
    messages: [],
    markdown: '# Welcome to cnctd\n\nThis Markdown file is shared with everyone in the session. Start typing to collaborate.\n',
    markdownVersion: 0,
    markdownUpdatedBy: null,
    markdownUpdatedAt: 0,
    lastActivity: Date.now(),
    createdAt: Date.now(),
  };
  sessions.set(id, session);
  return session;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

async function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); reject(new Error('payload too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // API
  if (req.method === 'POST' && req.url === '/api/sessions') {
    const s = createSession();
    sendJson(res, 200, { id: s.id });
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/api/sessions/')) {
    const id = decodeURIComponent(req.url.split('/').pop().split('?')[0]);
    const s = sessions.get(id);
    if (!s) { sendJson(res, 404, { error: 'not_found' }); return; }
    sendJson(res, 200, {
      id: s.id,
      userCount: s.users.size,
      capacity: MAX_USERS_PER_SESSION,
    });
    return;
  }

  // Static
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  // Treat /s/<id> as the app entry
  if (urlPath.startsWith('/s/')) urlPath = '/index.html';

  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MARKDOWN_LENGTH + 4096 });

server.on('upgrade', (req, socket, head) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { socket.destroy(); return; }

  if (url.pathname !== '/ws') { socket.destroy(); return; }

  const sessionId = url.searchParams.get('session') || '';
  const rawName = (url.searchParams.get('name') || '').trim();
  const name = rawName.slice(0, MAX_NAME_LENGTH);

  const session = sessions.get(sessionId);
  if (!session) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
  if (!name) { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return; }
  if (session.users.size >= MAX_USERS_PER_SESSION) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, session, name));
});

function safeSend(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  try { ws.send(payload); } catch { /* ignore */ }
}

function broadcast(session, obj, exceptUserId) {
  const str = typeof obj === 'string' ? obj : JSON.stringify(obj);
  for (const u of session.users.values()) {
    if (u.id === exceptUserId) continue;
    safeSend(u.ws, str);
  }
}

function onConnection(ws, session, requestedName) {
  const userId = genId(6);

  // Ensure unique display name within session
  const existing = new Set([...session.users.values()].map(u => u.name));
  let name = requestedName;
  let n = 2;
  while (existing.has(name)) name = `${requestedName} (${n++})`;

  const color = pickColor(userId);
  const user = { id: userId, name, color, ws, alive: true, joinedAt: Date.now() };
  session.users.set(userId, user);
  session.lastActivity = Date.now();

  ws.on('pong', () => { user.alive = true; });

  // Initial state
  safeSend(ws, JSON.stringify({
    type: 'init',
    sessionId: session.id,
    you: { id: userId, name, color },
    users: [...session.users.values()].map(u => ({ id: u.id, name: u.name, color: u.color })),
    messages: session.messages.slice(-MAX_MESSAGES_ON_JOIN),
    markdown: session.markdown,
    markdownVersion: session.markdownVersion,
    capacity: MAX_USERS_PER_SESSION,
  }));

  // Notify others
  broadcast(session, {
    type: 'user_joined',
    user: { id: userId, name, color },
    userCount: session.users.size,
  }, userId);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    session.lastActivity = Date.now();

    if (msg.type === 'message') {
      const text = String(msg.text || '').slice(0, MAX_MESSAGE_LENGTH);
      if (!text.trim()) return;
      const m = {
        id: genId(8),
        userId, name, color,
        text,
        ts: Date.now(),
      };
      session.messages.push(m);
      if (session.messages.length > MAX_MESSAGES_RETAINED) {
        session.messages.splice(0, session.messages.length - MAX_MESSAGES_RETAINED);
      }
      broadcast(session, { type: 'message', message: m });
      return;
    }

    if (msg.type === 'md_update') {
      const content = String(msg.content || '').slice(0, MAX_MARKDOWN_LENGTH);
      session.markdown = content;
      session.markdownVersion += 1;
      session.markdownUpdatedBy = userId;
      session.markdownUpdatedAt = Date.now();
      broadcast(session, {
        type: 'md_update',
        content,
        version: session.markdownVersion,
        by: { id: userId, name, color },
      }, userId);
      return;
    }

    if (msg.type === 'md_cursor') {
      // lightweight presence in the editor; broadcast minimal info
      broadcast(session, {
        type: 'md_cursor',
        userId,
        editing: !!msg.editing,
      }, userId);
      return;
    }

    if (msg.type === 'ping') {
      safeSend(ws, JSON.stringify({ type: 'pong', t: Date.now() }));
      return;
    }
  });

  ws.on('close', () => {
    session.users.delete(userId);
    broadcast(session, {
      type: 'user_left',
      userId,
      userCount: session.users.size,
    });
  });

  ws.on('error', () => { /* handled by close */ });
}

// Heartbeat to drop dead sockets
const heartbeat = setInterval(() => {
  for (const session of sessions.values()) {
    for (const user of session.users.values()) {
      if (!user.alive) {
        try { user.ws.terminate(); } catch {}
        continue;
      }
      user.alive = false;
      try { user.ws.ping(); } catch {}
    }
  }
}, HEARTBEAT_MS);

// Sweep idle empty sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.users.size === 0 && now - s.lastActivity > SESSION_IDLE_TTL_MS) {
      sessions.delete(id);
    }
  }
}, 60_000);

server.listen(PORT, HOST, () => {
  console.log(`cnctd listening on http://${HOST}:${PORT}`);
});

process.on('SIGTERM', () => {
  clearInterval(heartbeat);
  server.close(() => process.exit(0));
});
