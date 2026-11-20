const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const url = require('url');

const PORT = process.env.PORT || 8080;
const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASS = process.env.AUTH_PASS || 'antigravity2026';
const AGENT_KEY = process.env.AGENT_KEY || 'ag-secret-agent-key-2026';

let hostSocket = null;
const viewerSockets = new Set();

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      hostConnected: Boolean(hostSocket && hostSocket.readyState === WebSocket.OPEN),
      viewers: viewerSockets.size
    }));
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Remote Desktop Relay Active');
});

const wss = new WebSocketServer({
  server,
  maxPayload: 10 * 1024 * 1024,
  perMessageDeflate: false
});

function broadcastHostStatus() {
  const msg = JSON.stringify({
    type: 'status',
    hostOnline: Boolean(hostSocket && hostSocket.readyState === WebSocket.OPEN),
    viewers: viewerSockets.size
  });
  for (const v of viewerSockets) {
    if (v.readyState === WebSocket.OPEN) v.send(msg);
  }
  if (hostSocket && hostSocket.readyState === WebSocket.OPEN) {
    hostSocket.send(JSON.stringify({ type: 'viewers', count: viewerSockets.size }));
  }
}

wss.on('connection', (ws, req) => {
  if (ws._socket && ws._socket.setNoDelay) {
    ws._socket.setNoDelay(true);
  }
  const parsed = url.parse(req.url, true);
  const { role, user, pass, key } = parsed.query;

  if (role === 'host') {
    if (key !== AGENT_KEY) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid agent key' }));
      return ws.close(4001, 'Unauthorized');
    }
    if (hostSocket && hostSocket.readyState === WebSocket.OPEN) {
      try { hostSocket.close(4000, 'Replaced by new host'); } catch {}
    }
    hostSocket = ws;
    console.log('[Relay] Host connected');
    broadcastHostStatus();

    ws.on('message', (data, isBinary) => {
      for (const v of viewerSockets) {
        // Strict drop-frame backpressure: only send binary frame if viewer TCP buffer is nearly empty (<64KB)
        if (v.readyState === WebSocket.OPEN) {
          if (!isBinary || v.bufferedAmount < 65536) {
            v.send(data, { binary: isBinary });
          }
        }
      }
    });

    ws.on('close', () => {
      if (hostSocket === ws) hostSocket = null;
      console.log('[Relay] Host disconnected');
      broadcastHostStatus();
    });
    ws.on('error', () => {});
  } else if (role === 'viewer') {
    if (user !== AUTH_USER || pass !== AUTH_PASS) {
      ws.send(JSON.stringify({ type: 'auth_error', message: 'Неверный логин или пароль' }));
      return ws.close(4003, 'Invalid credentials');
    }
    viewerSockets.add(ws);
    ws.send(JSON.stringify({
      type: 'auth_ok',
      hostOnline: Boolean(hostSocket && hostSocket.readyState === WebSocket.OPEN)
    }));
    broadcastHostStatus();

    ws.on('message', (data) => {
      if (hostSocket && hostSocket.readyState === WebSocket.OPEN) {
        hostSocket.send(data.toString());
      }
    });

    ws.on('close', () => {
      viewerSockets.delete(ws);
      broadcastHostStatus();
    });
    ws.on('error', () => {});
  } else {
    ws.close(4002, 'Unknown role');
  }
});

// Keep-alive ping every 25s
setInterval(() => {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.ping(); } catch {}
    }
  }
}, 25000);

server.listen(PORT, () => {
  console.log(`Relay server listening on port ${PORT}`);
});
