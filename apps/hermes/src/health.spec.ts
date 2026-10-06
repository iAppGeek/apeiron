import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { closeServer, startHealthServer } from './health.js';

describe('health server', () => {
  it('serves /health with 503 until ready, then 200, and 404 elsewhere', async () => {
    let ready = false;
    const server = await startHealthServer(0, () => ({ status: ready ? 'ok' : 'starting' }), () => ready);
    const port = (server.address() as AddressInfo).port;
    try {
      const before = await fetch(`http://127.0.0.1:${port}/health`);
      expect(before.status).toBe(503);
      expect(await before.json()).toEqual({ status: 'starting' });
      ready = true;
      const after = await fetch(`http://127.0.0.1:${port}/health`);
      expect(after.status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
    } finally {
      await closeServer(server);
    }
  });
});
