import { describe, expect, it, vi } from 'vitest';
import { MetricsScraper, resourceSampleOf, summarizeResources, type ResourceSample } from './scraper.js';
import { parseProm } from './prom.js';
import type { Clock } from './schedule.js';

const text = (cpu: number, rss: number, lag99: number, soft = 0, slow = 0): string => `process_cpu_seconds_total ${cpu}
process_resident_memory_bytes ${rss * 1048576}
nodejs_heap_size_used_bytes ${rss * 524288}
apeiron_event_loop_lag_seconds{quantile="0.99"} ${lag99 / 1000}
apeiron_event_loop_lag_seconds{quantile="max"} ${(lag99 * 2) / 1000}
apeiron_ws_connections 50
apeiron_backpressure_events_total{event="soft_conflate"} ${soft}
apeiron_backpressure_events_total{event="slow_consumer"} ${slow}
`;

function clock(): Clock & { t: number } {
  const c = { t: 0, now: (): number => c.t, sleep: (ms: number): Promise<void> => ((c.t += ms), Promise.resolve()) };
  return c;
}

describe('resourceSampleOf', () => {
  it('turns the CPU counter into a percentage of one core over the gap', () => {
    const first = resourceSampleOf(parseProm(text(10, 700, 5)), 0, null);
    expect(first.sample.cpuPercent).toBeNull();
    const second = resourceSampleOf(parseProm(text(11, 720, 8)), 2000, { t: 0, cpuSeconds: first.cpuSeconds });
    expect(second.sample.cpuPercent).toBeCloseTo(50, 6);
    expect(second.sample).toMatchObject({ rssMb: 720, heapUsedMb: 360, lagP99Ms: 8, lagMaxMs: 16, clients: 50 });
  });

  it('tolerates a server that lacks the lag series', () => {
    const { sample } = resourceSampleOf(parseProm('process_cpu_seconds_total 1\n'), 0, null);
    expect(sample.lagP99Ms).toBeNull();
    expect(sample.rssMb).toBe(0);
  });
});

describe('summarizeResources', () => {
  it('gives min, median and max per series, skipping missing values', () => {
    const mk = (cpu: number | null, rss: number): ResourceSample => ({ t: 0, cpuPercent: cpu, rssMb: rss, heapUsedMb: 1, lagP99Ms: 2, lagMaxMs: 3, clients: 1, softConflates: 0, slowConsumers: 0 });
    const r = summarizeResources([mk(null, 800), mk(10, 900), mk(30, 1000)], 1);
    expect(r.cpuPercent).toEqual({ min: 10, median: 10, max: 30, samples: 2 });
    expect(r.rssMb).toEqual({ min: 800, median: 900, max: 1000, samples: 3 });
    expect(r.failures).toBe(1);
  });
});

describe('MetricsScraper', () => {
  it('scrapes on an interval, keeps the first and last scrape, and counts failures', async () => {
    const c = clock();
    let n = 0;
    const fetcher = vi.fn(async () => {
      n++;
      if (n === 3) throw new Error('down');
      return text(n, 700 + n, 5);
    });
    const s = new MetricsScraper('http://x/metrics', c, 0, 2000, fetcher);
    for (let i = 0; i < 4; i++) {
      await s.scrapeOnce();
      c.t += 2000;
    }
    expect(s.samples).toHaveLength(3);
    expect(s.failures).toBe(1);
    expect(s.first).not.toBeNull();
    expect(s.report().rssMb?.max).toBe(704);
  });

  it('finds when a counter first grew after a given time', async () => {
    const c = clock();
    const values = [0, 0, 1, 1];
    let i = 0;
    const s = new MetricsScraper('u', c, 0, 2000, async () => text(i, 700, 5, values[i++] ?? 0));
    for (let k = 0; k < 4; k++) {
      await s.scrapeOnce();
      c.t += 2000;
    }
    expect(s.firstGrowth('softConflates', 0)).toBe(4000);
    expect(s.firstGrowth('softConflates', 4000)).toBeNull();
    expect(s.firstGrowth('slowConsumers', 0)).toBeNull();
  });

  it('start and stop run the loop and take a final scrape', async () => {
    const c = clock();
    const fetcher = vi.fn(async () => text(1, 700, 5));
    const s = new MetricsScraper('u', c, 0, 2000, fetcher);
    s.start();
    await Promise.resolve();
    await s.stop();
    expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
