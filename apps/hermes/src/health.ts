import { createServer, type Server } from 'node:http';

/** A tiny HTTP `/health` endpoint for the compose healthcheck. */
export function startHealthServer(port: number, body: () => unknown, ready: () => boolean): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(ready() ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body()));
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
