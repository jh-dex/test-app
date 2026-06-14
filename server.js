const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;

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

const clients = new Set();

// Authoritative board state for late-joiner sync.
// Clients push a full snapshot ('state-store') after each committed change;
// the server keeps only the latest one and replays it to anyone who connects.
let boardSnapshot = null;

function sendSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(payload, exclude) {
  for (const client of clients) {
    if (client === exclude) continue;
    sendSse(client, payload);
  }
}

function snapshotMessage() {
  return {
    id: `srv-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type: 'board-state',
    source: 'server',
    payload: boardSnapshot,
    sentAt: Date.now(),
  };
}

function safeFilePath(urlPath) {
  const sanitized = decodeURIComponent(urlPath.split('?')[0]);
  const relative = sanitized === '/' ? '/index.html' : sanitized;
  const fullPath = path.normalize(path.join(ROOT, relative));
  // Guard against path traversal: must stay inside ROOT.
  if (fullPath !== ROOT && !fullPath.startsWith(ROOT + path.sep)) return null;
  return fullPath;
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url?.startsWith('/events')) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(': connected\n\n');
    clients.add(res);

    // Replay current board to the freshly connected client only.
    if (boardSnapshot) {
      sendSse(res, snapshotMessage());
    }

    req.on('close', () => {
      clients.delete(res);
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

        // State snapshots are stored, not relayed (avoids flicker on peers).
        if (payload && payload.type === 'state-store') {
          boardSnapshot = payload.payload || null;
          res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
          res.end();
          return;
        }

        broadcast(payload);
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
  for (const client of clients) {
    client.write(': ping\n\n');
  }
}, 20000);

server.listen(PORT, HOST, () => {
  console.log(`Live Board server running at http://${HOST}:${PORT}`);
});
