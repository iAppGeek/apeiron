import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { closeServer, startHealthServer } from './health.js';

const base = (s: Awaited<ReturnType<typeof startHealthServer>>): string => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

describe('health server', () => {
  it('serves /health with 503 until ready, then 200, and 404 elsewhere', async () => {
    let ready = false;
    const server = await startHealthServer(0, () => ({ status: ready ? 'ok' : 'starting' }), () => ready);
    try {
      const before = await fetch(`${base(server)}/health`);
      expect(before.status).toBe(503);
      expect(await before.json()).toEqual({ status: 'starting' });
      ready = true;
      expect((await fetch(`${base(server)}/health`)).status).toBe(200);
      expect((await fetch(`${base(server)}/nope`)).status).toBe(404);
    } finally {
      await closeServer(server);
    }
  });

  it('serves /debug even before the service is ready', async () => {
    const server = await startHealthServer(0, () => ({}), () => false, undefined, () => ({ openOrders: 3 }));
    try {
      const res = await fetch(`${base(server)}/debug`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ openOrders: 3 });
    } finally {
      await closeServer(server);
    }
  });

  it('serves /metrics only when given a source', async () => {
    const without = await startHealthServer(0, () => ({}), () => true);
    const withSource = await startHealthServer(0, () => ({}), () => true, { contentType: 'text/plain; version=0.0.4', render: () => Promise.resolve('themis_up 1\n') });
    try {
      expect((await fetch(`${base(without)}/metrics`)).status).toBe(404);
      const res = await fetch(`${base(withSource)}/metrics`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('themis_up 1\n');
    } finally {
      await closeServer(without);
      await closeServer(withSource);
    }
  });
});
