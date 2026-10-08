import { describe, expect, it, vi } from 'vitest';
import { createFaults, RESET_WINDOW_MS } from './faults';

type Call = { method: string; url: string; body: unknown };

function rig(toxics: string[] = []): { calls: Call[]; faults: ReturnType<typeof createFaults>; sleeps: number[] } {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const fakeFetch = vi.fn((url: string, init?: { method?: string; body?: string }): Promise<Response> => {
    calls.push({ method: init?.method ?? 'GET', url, body: init?.body === undefined ? undefined : (JSON.parse(init.body) as unknown) });
    if (init?.method === 'GET') return Promise.resolve(new Response(JSON.stringify(toxics.map((name) => ({ name }))), { status: 200 }));
    return Promise.resolve(new Response(null, { status: init?.method === 'DELETE' ? 204 : 200 }));
  });
  const faults = createFaults({
    fetch: fakeFetch as unknown as typeof fetch,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  return { calls, faults, sleeps };
}

const summary = (calls: Call[]): string[] => calls.map((c) => `${c.method} ${c.url.replace('http://127.0.0.1:8474', '')}`);

describe('createFaults', () => {
  it('dropClean adds a reset_peer toxic with timeout 0, waits, and removes it', async () => {
    const { calls, faults, sleeps } = rig();
    await faults.dropClean();
    expect(summary(calls)).toEqual(['DELETE /proxies/ws/toxics/reset', 'POST /proxies/ws/toxics', 'DELETE /proxies/ws/toxics/reset']);
    expect(calls[1]?.body).toEqual({ name: 'reset', type: 'reset_peer', stream: 'downstream', toxicity: 1, attributes: { timeout: 0 } });
    expect(sleeps).toEqual([RESET_WINDOW_MS]);
  });

  it('down disables the proxy, waits, and enables it again even when the wait throws', async () => {
    const { calls, faults, sleeps } = rig();
    await faults.down(3000);
    expect(calls.map((c) => c.body)).toEqual([{ enabled: false }, { enabled: true }]);
    expect(sleeps).toEqual([3000]);

    const failing = createFaults({
      fetch: vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))) as unknown as typeof fetch,
      sleep: () => Promise.reject(new Error('interrupted')),
    });
    await expect(failing.down(10)).rejects.toThrow('interrupted');
  });

  it('stall adds a timeout toxic of 0 in both directions', async () => {
    const { calls, faults } = rig();
    await faults.stall();
    const posts = calls.filter((c) => c.method === 'POST').map((c) => c.body);
    expect(posts).toEqual([
      { name: 'stall-upstream', type: 'timeout', stream: 'upstream', toxicity: 1, attributes: { timeout: 0 } },
      { name: 'stall-downstream', type: 'timeout', stream: 'downstream', toxicity: 1, attributes: { timeout: 0 } },
    ]);
  });

  it('latency and bandwidth set their attributes per direction', async () => {
    const { calls, faults } = rig();
    await faults.latency(300, 100);
    await faults.bandwidth(64, 'downstream');
    const posts = calls.filter((c) => c.method === 'POST').map((c) => c.body);
    expect(posts).toEqual([
      { name: 'latency-upstream', type: 'latency', stream: 'upstream', toxicity: 1, attributes: { latency: 300, jitter: 100 } },
      { name: 'latency-downstream', type: 'latency', stream: 'downstream', toxicity: 1, attributes: { latency: 300, jitter: 100 } },
      { name: 'bandwidth-downstream', type: 'bandwidth', stream: 'downstream', toxicity: 1, attributes: { rate: 64 } },
    ]);
  });

  it('clear removes every toxic and enables the proxy', async () => {
    const { calls, faults } = rig(['a', 'b']);
    await faults.clear();
    expect(summary(calls)).toEqual([
      'GET /proxies/ws/toxics',
      'DELETE /proxies/ws/toxics/a',
      'DELETE /proxies/ws/toxics/b',
      'POST /proxies/ws',
    ]);
    expect(calls.at(-1)?.body).toEqual({ enabled: true });
  });

  it('retries a 5xx from the API before giving up', async () => {
    const statuses = [503, 503, 200];
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: statuses.shift() ?? 200 })));
    const faults = createFaults({ fetch: fetchMock as unknown as typeof fetch, sleep: () => Promise.resolve() });
    await faults.latency(1, 0);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it('reports an API failure with its status', async () => {
    const faults = createFaults({
      fetch: vi.fn(() => Promise.resolve(new Response('nope', { status: 500 }))) as unknown as typeof fetch,
    });
    await expect(faults.stall()).rejects.toThrow(/500/);
  });
});
