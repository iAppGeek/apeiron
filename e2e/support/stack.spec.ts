import { jsonCodec, type ClientMsg, type ServerMsg } from '@apeiron/logos';
import { afterEach, describe, expect, it, vi } from 'vitest';

const exec = vi.hoisted(() => ({ calls: [] as string[][], stdout: '' }));
vi.mock('node:child_process', () => ({
  execFile: (_file: string, args: string[], _options: unknown, callback: (error: Error | null, result: { stdout: string; stderr: string }) => void): void => {
    exec.calls.push(args);
    callback(null, { stdout: exec.stdout, stderr: '' });
  },
}));

const { healthOf, readiness, restartService, startBlotterProbe, waitHealthy } = await import('./stack');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  exec.calls.length = 0;
  exec.stdout = '';
});

const reply = (status: number): Response => new Response(null, { status });

describe('compose helpers', () => {
  it('restarts a service in the core profile', async () => {
    await restartService('themis');
    expect(exec.calls).toEqual([['compose', '--profile', 'core', 'restart', 'themis']]);
  });

  it('reads the health of a service, and says none when compose prints nothing', async () => {
    exec.stdout = 'healthy\n';
    await expect(healthOf('themis')).resolves.toBe('healthy');
    exec.stdout = '';
    await expect(healthOf('themis')).resolves.toBe('none');
  });

  it('waits until the service is healthy, and gives up after the timeout', async () => {
    exec.stdout = 'healthy\n';
    await expect(waitHealthy('themis', 5_000)).resolves.toBe(true);
    exec.stdout = 'starting\n';
    await expect(waitHealthy('themis', 1_200)).resolves.toBe(false);
  });
});

describe('readiness', () => {
  it('reads both endpoints, and null for one that does not answer', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => (url.endsWith('/live') ? Promise.resolve(reply(200)) : Promise.reject(new Error('refused')))));
    await expect(readiness()).resolves.toEqual({ live: 200, ready: null });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(reply(503))));
    await expect(readiness()).resolves.toEqual({ live: 503, ready: 503 });
  });
});

/** A socket that answers like the blotter: a welcome to a hello, then the rows (or nothing) to a getRows. */
function stubSocket(behaviour: { rows: boolean; fail?: boolean }): void {
  class FakeSocket {
    binaryType = '';
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor() {
      setTimeout(() => (behaviour.fail === true ? this.onerror?.() : this.onopen?.()), 0);
    }
    send(data: string): void {
      const msg = jsonCodec.decode(data) as ClientMsg;
      const answer = (m: ServerMsg): void => void setTimeout(() => this.onmessage?.({ data: jsonCodec.encode(m) as string }), 0);
      if (msg.t === 'hello') answer({ t: 'welcome', serverTime: 1, traders: [], columnsVersion: 'v', preset: null });
      else if (msg.t === 'getRows' && behaviour.rows) answer({ t: 'rows', reqId: msg.reqId, rows: [], rowCount: 0, ms: 1 });
    }
    close(): void {
      this.onclose?.();
    }
  }
  vi.stubGlobal('WebSocket', FakeSocket);
}

describe('startBlotterProbe', () => {
  it('counts a ready blotter that serves rows, and no early service', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(reply(200))));
    stubSocket({ rows: true });
    const probe = startBlotterProbe(5);
    await vi.waitFor(async () => undefined, { timeout: 200 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const seen = await probe.stop();
    expect(seen.served).toBeGreaterThan(0);
    expect(seen.welcomed).toBeGreaterThanOrEqual(seen.served);
    expect(seen.ready).toBeGreaterThan(0);
    expect(seen.servedBeforeReady).toBe(0);
    expect(seen.down).toBe(0);
  });

  it('flags rows served by a blotter that never said ready', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(reply(503))));
    stubSocket({ rows: true });
    const probe = startBlotterProbe(5);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const seen = await probe.stop();
    expect(seen.servedBeforeReady).toBeGreaterThan(0);
    expect(seen.liveNotReady).toBeGreaterThan(0);
  });

  it('does not flag a blotter that is loading and serves nothing, and counts one that is down', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(reply(503))));
    stubSocket({ rows: false });
    const loading = startBlotterProbe(5);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await loading.stop()).servedBeforeReady).toBe(0);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('refused'))));
    stubSocket({ rows: false, fail: true });
    const down = startBlotterProbe(5);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const seen = await down.stop();
    expect(seen.down).toBeGreaterThan(0);
    expect(seen.welcomed).toBe(0);
  });
});
