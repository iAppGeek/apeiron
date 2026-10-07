import type { ServerMsg } from '@apeiron/logos';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Options } from './args.js';
import { fetchLag, runLoadTest, stressPhases } from './run.js';
import { FakeSocket, autoServer } from './testing/fake-socket.js';

afterEach(() => vi.useRealTimers());

const BASE: Options = {
  clients: 6,
  duration: 90,
  codec: 'both',
  url: 'ws://fake/ws',
  metrics: 'http://fake:4000/metrics',
  seed: 1,
  out: null,
  scrollRate: 2,
  changeEvery: 20,
  commandRate: 0.2,
  stressAt: null,
  stressFor: 30,
  switchEvery: 20,
  noSpecial: false,
  slowAt: 10,
  help: false,
};

describe('stressPhases', () => {
  it('centres the window in the run unless told otherwise', () => {
    expect(stressPhases({ duration: 300, stressAt: null, stressFor: 60, noSpecial: false })).toEqual({ stressFromS: 120, stressToS: 180 });
    expect(stressPhases({ duration: 300, stressAt: 30, stressFor: 60, noSpecial: false })).toEqual({ stressFromS: 30, stressToS: 90 });
  });

  it('is off for short runs, zero length, --no-special and windows that overrun', () => {
    expect(stressPhases({ duration: 60, stressAt: null, stressFor: 60, noSpecial: false })).toBeNull();
    expect(stressPhases({ duration: 300, stressAt: null, stressFor: 0, noSpecial: false })).toBeNull();
    expect(stressPhases({ duration: 300, stressAt: null, stressFor: 60, noSpecial: true })).toBeNull();
    expect(stressPhases({ duration: 100, stressAt: 80, stressFor: 60, noSpecial: false })).toBeNull();
  });
});

describe('fetchLag', () => {
  it('reads /debug/lag from the server origin and tolerates failure', async () => {
    const urls: string[] = [];
    const lag = await fetchLag('http://h:4000', async (u) => (urls.push(u), JSON.stringify({ lag: { p50: 1, p99: 2, max: 3, samples: 4 } })), true);
    expect(lag).toEqual({ p50: 1, p99: 2, max: 3, samples: 4 });
    expect(urls).toEqual(['http://h:4000/debug/lag?reset=1']);
    expect(await fetchLag('http://h', async () => Promise.reject(new Error('x')), false)).toBeNull();
    expect(await fetchLag('http://h', async () => '{"live":false}', false)).toBeNull();
  });
});

const PROM = (cpu: number, slow: number): string => `process_cpu_seconds_total ${cpu}
process_resident_memory_bytes 900000000
apeiron_event_loop_lag_seconds{quantile="0.99"} 0.004
apeiron_backpressure_events_total{event="slow_consumer"} ${slow}
apeiron_backpressure_events_total{event="soft_conflate"} ${slow * 3}
`;

describe('runLoadTest', () => {
  it('runs a whole scenario against a fake server: clients, special clients, stress window, report', async () => {
    vi.useFakeTimers({ now: 2_000_000_000_000 });
    const sockets = new Map<string, FakeSocket>();
    let scrapes = 0;
    const controls: string[] = [];
    let slowClosed = false;
    const connect = async (): Promise<FakeSocket> => {
      const s = new FakeSocket();
      let id = '';
      autoServer(s, {
        rows: [{ orderId: 'L1', status: 'LIVE', currencyPair: 'EURUSD' }],
        seen: (m) => {
          if (m.t === 'hello') {
            id = m.clientId;
            sockets.set(id, s);
          }
          if (m.t === 'control') controls.push(m.preset);
        },
      });
      return s;
    };
    const fetcher = async (url: string): Promise<string> => {
      if (url.includes('/debug/lag')) return JSON.stringify({ lag: { p50: 1, p99: 3, max: 20, samples: 500 } });
      scrapes++;
      // After the slow consumer has been paused a while, report that the server closed one.
      const slow = sockets.get('talos-1-1')?.paused === true ? 0 : slowClosed ? 1 : 0;
      return PROM(scrapes, slow);
    };
    const run = runLoadTest(BASE, { connect, fetcher });
    // Push a delta to every client every 100ms, as the real server would.
    const feeder = setInterval(() => {
      for (const s of sockets.values()) {
        if (s.paused) continue;
        const delta: ServerMsg = { t: 'delta', seq: 1, serverTs: Date.now() - 5, updates: [], groupUpdates: [], adds: [], dirtyRoutes: [], rowCounts: [], newAbove: 0 };
        s.deliver(delta, s.sent.at(-1)?.binary === true ? 'msgpack' : 'json');
      }
    }, 100);
    await vi.advanceTimersByTimeAsync(25_000);
    slowClosed = true;
    await vi.advanceTimersByTimeAsync(80_000);
    clearInterval(feeder);
    const report = await run;

    expect(report.meta).toMatchObject({ clients: 6, codec: 'both', seed: 1 });
    expect(report.codecs.map((c) => c.codec)).toEqual(['json', 'msgpack']);
    for (const c of report.codecs) {
      expect(c.getRows.warm?.count).toBeGreaterThan(20);
      expect(c.delta?.count).toBeGreaterThan(50);
      expect(c.delta?.p50).toBeGreaterThanOrEqual(0);
    }
    expect(report.phases).toEqual({ stressFromS: 30, stressToS: 60 });
    expect(controls).toEqual(['stress', 'medium']);
    const names = report.events.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['slow.paused', 'slow.resumed', 'codec.switch', 'stress.stress', 'stress.medium']));
    expect(names).toContain('server.slow_consumer_first_seen');
    expect(report.server?.scrapes).toBeGreaterThan(30);
    expect(report.server?.rssMb?.max).toBeCloseTo(858.3, 0);
    expect(report.eventLoopLagCumulative?.p99).toBe(3);
    expect(report.targets).toHaveLength(5);
    expect(report.counters.connectFailures).toBe(0);
    expect(report.generator.sendLagMs).not.toBeNull();
    for (const s of sockets.values()) expect(s.closedWith).not.toBeNull();
  });

  it('counts a client that cannot connect and still reports', async () => {
    vi.useFakeTimers({ now: 2_000_000_000_000 });
    const run = runLoadTest({ ...BASE, clients: 2, duration: 5, noSpecial: true, metrics: 'off', codec: 'json' }, { connect: () => Promise.reject(new Error('refused')) });
    await vi.advanceTimersByTimeAsync(10_000);
    const report = await run;
    expect(report.counters.connectFailures).toBe(2);
    expect(report.server).toBeNull();
    expect(report.codecs[0]?.getRows.warm).toBeNull();
  });

  it('ends early when asked to stop', async () => {
    vi.useFakeTimers({ now: 2_000_000_000_000 });
    let stop = false;
    const connect = async (): Promise<FakeSocket> => {
      const s = new FakeSocket();
      autoServer(s);
      return s;
    };
    const run = runLoadTest({ ...BASE, clients: 2, duration: 300, noSpecial: true, metrics: 'off', codec: 'json' }, { connect, stopped: () => stop });
    await vi.advanceTimersByTimeAsync(5_000);
    stop = true;
    await vi.advanceTimersByTimeAsync(5_000);
    const report = await run;
    expect(report.codecs[0]?.getRows.warm?.count).toBeLessThan(40);
  });
});
