const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const MAX_ROOM_HISTORY = 500;
const rooms = new Map();
let persistTimer = null;

function persistRoomsSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const payload = {};
    for (const [roomId, room] of rooms.entries()) {
      payload[roomId] = room.history;
    }
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(ROOMS_FILE, JSON.stringify(payload), 'utf8');
    } catch (error) {
      console.error('Failed to persist room history:', error);
    }
  }, 200);
}

function loadRoomsFromDisk() {
  try {
    if (!fs.existsSync(ROOMS_FILE)) return;
    const raw = fs.readFileSync(ROOMS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    for (const [roomId, history] of Object.entries(parsed)) {
      rooms.set(roomId, {
        clients: new Set(),
        history: Array.isArray(history) ? history.slice(-MAX_ROOM_HISTORY) : [],
      });
    }
  } catch (error) {
    console.error('Failed to load room history:', error);
  }
}

function getRoom(roomId) {
  const safeId = String(roomId || 'lobby');
  if (!rooms.has(safeId)) {
    rooms.set(safeId, {
      clients: new Set(),
      history: [],
    });
  }
  return rooms.get(safeId);
}

function sendSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(room, payload) {
  for (const client of room.clients) {
    sendSse(client, payload);
  }
}

function safeFilePath(urlPath) {
  const sanitized = decodeURIComponent(urlPath.split('?')[0]);
  const relative = sanitized === '/' ? '/index.html' : sanitized;
  const fullPath = path.normalize(path.join(ROOT, relative));
  if (!fullPath.startsWith(ROOT)) return null;
  return fullPath;
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url?.startsWith('/events')) {
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const roomId = parsed.searchParams.get('room') || 'lobby';
    const room = getRoom(roomId);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(': connected\n\n');
    room.clients.add(res);
    room.history.forEach((message) => sendSse(res, message));

    req.on('close', () => {
      room.clients.delete(res);
      res.end();
    });
    return;
  }

  if (req.method === 'POST' && req.url?.startsWith('/sync')) {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 30 * 1024 * 1024) {
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const roomId = payload.room || 'lobby';
        const room = getRoom(roomId);
        if (payload.type !== 'presence') {
          room.history.push(payload);
          if (room.history.length > MAX_ROOM_HISTORY) {
            room.history.shift();
          }
          persistRoomsSoon();
        }
        broadcast(room, payload);
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
        });
        res.end();
      } catch {
        res.writeHead(400);
        res.end('Invalid JSON');
      }
    });
    return;
  }

  if (req.method === 'OPTIONS' && (req.url?.startsWith('/sync') || req.url?.startsWith('/events'))) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const fullPath = safeFilePath(req.url || '/');
  if (!fullPath) {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

setInterval(() => {
  for (const room of rooms.values()) {
    for (const client of room.clients) {
      client.write(': ping\n\n');
    }
  }
}, 20000);

loadRoomsFromDisk();

server.listen(PORT, HOST, () => {
  console.log(`Live Board server running at http://${HOST}:${PORT}`);
});
