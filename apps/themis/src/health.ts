import { createServer, type Server } from 'node:http';

/** What `/metrics` needs: the exposition text and its content type. */
export type MetricsSource = { contentType: string; render(): Promise<string> };

/** A tiny HTTP server: `/health` for the compose healthcheck (503 until ready), `/debug` for internals and, when given a source, `/metrics`. */
export function startHealthServer(
  port: number,
  body: () => unknown,
  ready: () => boolean,
  metrics?: MetricsSource,
  debug: () => unknown = () => ({}),
): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(ready() ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body()));
      return;
    }
    if (req.url === '/debug') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(debug()));
      return;
    }
    if (req.url === '/metrics' && metrics !== undefined) {
      metrics.render().then(
        (text) => {
          res.writeHead(200, { 'content-type': metrics.contentType });
          res.end(text);
        },
        () => {
          res.writeHead(500).end();
        },
      );
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
