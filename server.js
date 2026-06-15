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

const DEFAULT_CANVAS_ID = 'default';
const clientsByCanvas = new Map();
const snapshotsByCanvas = new Map();

// Authoritative board state for late-joiner sync, scoped per canvas.
// Clients push a full snapshot ('state-store') after each committed change;
// the server keeps only the latest one and replays it to anyone who connects.
function normalizeCanvasId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!id) return DEFAULT_CANVAS_ID;
  return /^[a-z0-9_-]{1,80}$/.test(id) ? id : DEFAULT_CANVAS_ID;
}

function getRequestCanvasId(req) {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    return normalizeCanvasId(url.searchParams.get('canvas'));
  } catch {
    return DEFAULT_CANVAS_ID;
  }
}

function getCanvasClients(canvasId) {
  const id = normalizeCanvasId(canvasId);
  if (!clientsByCanvas.has(id)) {
    clientsByCanvas.set(id, new Set());
  }
  return clientsByCanvas.get(id);
}

function dropClient(canvasId, res) {
  const clients = clientsByCanvas.get(normalizeCanvasId(canvasId));
  if (clients) {
    clients.delete(res);
    if (clients.size === 0) clientsByCanvas.delete(normalizeCanvasId(canvasId));
  }
  try {
    res.end();
  } catch {
    // already closed
  }
}

function sendSse(canvasId, res, payload) {
  // Guard every write: a dead/half-open connection would otherwise throw and
  // abort the broadcast loop, so clients later in the set silently miss the
  // message (causes "some windows update, some don't"). Prune on failure.
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch {
    dropClient(canvasId, res);
    return false;
  }
}

function broadcast(canvasId, payload, exclude) {
  const clients = clientsByCanvas.get(normalizeCanvasId(canvasId));
  if (!clients) return;
  for (const client of [...clients]) {
    if (client === exclude) continue;
    sendSse(canvasId, client, payload);
  }
}

function snapshotMessage(canvasId) {
  return {
    id: `srv-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type: 'board-state',
    source: 'server',
    payload: snapshotsByCanvas.get(normalizeCanvasId(canvasId)) || null,
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
    const canvasId = getRequestCanvasId(req);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(': connected\n\n');
    const clients = getCanvasClients(canvasId);
    clients.add(res);

    // Replay current board to the freshly connected client only.
    if (snapshotsByCanvas.has(canvasId)) {
      sendSse(canvasId, res, snapshotMessage(canvasId));
    }

    req.on('close', () => {
      dropClient(canvasId, res);
    });
    return;
  }

  if (req.method === 'POST' && req.url?.startsWith('/sync')) {
    const canvasId = getRequestCanvasId(req);
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 30 * 1024 * 1024) {
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        // Clients coalesce messages per animation frame into a single POST
        // ({ batch: [...] }). Accept both batched and single-message bodies.
        const messages = Array.isArray(data.batch) ? data.batch : [data];

        for (const msg of messages) {
          if (!msg) continue;
          // State snapshots are stored, not relayed (avoids flicker on peers).
          if (msg.type === 'state-store') {
            if (msg.payload) {
              snapshotsByCanvas.set(canvasId, msg.payload);
            } else {
              snapshotsByCanvas.delete(canvasId);
            }
          } else {
            broadcast(canvasId, msg);
          }
        }

        res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
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
  for (const [canvasId, clients] of [...clientsByCanvas]) {
    for (const client of [...clients]) {
      try {
        client.write(': ping\n\n');
      } catch {
        dropClient(canvasId, client);
      }
    }
  }
}, 20000);

server.listen(PORT, HOST, () => {
  console.log(`Live Board server running at http://${HOST}:${PORT}`);
});
