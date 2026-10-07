import { parseProm, sumOf, valueOf, type Sample } from './prom.js';
import { rangeOf, type Range } from './stats.js';
import type { Clock } from './schedule.js';

export type ResourceSample = {
  /** Run-clock time of the scrape, ms. */
  t: number;
  /** Process CPU in percent of one core over the gap since the previous scrape (null for the first scrape). */
  cpuPercent: number | null;
  rssMb: number;
  heapUsedMb: number;
  /** p99 of the server's event-loop lag over its last one-second window, ms. */
  lagP99Ms: number | null;
  lagMaxMs: number | null;
  clients: number | null;
  softConflates: number;
  slowConsumers: number;
};

export type ResourceReport = {
  cpuPercent: Range | null;
  rssMb: Range | null;
  heapUsedMb: Range | null;
  eventLoopLagP99Ms: Range | null;
  eventLoopLagMaxMs: Range | null;
  scrapes: number;
  failures: number;
};

export type Fetcher = (url: string) => Promise<string>;

export const fetchText: Fetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.text();
};

export function resourceSampleOf(samples: readonly Sample[], t: number, previous: { t: number; cpuSeconds: number } | null): { sample: ResourceSample; cpuSeconds: number } {
  const cpuSeconds = valueOf(samples, 'process_cpu_seconds_total') ?? 0;
  const dt = previous === null ? 0 : (t - previous.t) / 1000;
  const lagP99 = valueOf(samples, 'apeiron_event_loop_lag_seconds', { quantile: '0.99' });
  const lagMax = valueOf(samples, 'apeiron_event_loop_lag_seconds', { quantile: 'max' });
  const clients = valueOf(samples, 'apeiron_ws_connections');
  return {
    cpuSeconds,
    sample: {
      t,
      cpuPercent: previous === null || dt <= 0 ? null : Math.max(0, ((cpuSeconds - previous.cpuSeconds) / dt) * 100),
      rssMb: (valueOf(samples, 'process_resident_memory_bytes') ?? 0) / 1048576,
      heapUsedMb: (valueOf(samples, 'nodejs_heap_size_used_bytes') ?? 0) / 1048576,
      lagP99Ms: lagP99 === undefined ? null : lagP99 * 1000,
      lagMaxMs: lagMax === undefined ? null : lagMax * 1000,
      clients: clients ?? null,
      softConflates: sumOf(samples, 'apeiron_backpressure_events_total', { event: 'soft_conflate' }),
      slowConsumers: sumOf(samples, 'apeiron_backpressure_events_total', { event: 'slow_consumer' }),
    },
  };
}

export function summarizeResources(samples: readonly ResourceSample[], failures: number): ResourceReport {
  const col = (pick: (s: ResourceSample) => number | null): Range | null =>
    rangeOf(samples.map(pick).filter((v): v is number => v !== null));
  return {
    cpuPercent: col((s) => s.cpuPercent),
    rssMb: col((s) => s.rssMb),
    heapUsedMb: col((s) => s.heapUsedMb),
    eventLoopLagP99Ms: col((s) => s.lagP99Ms),
    eventLoopLagMaxMs: col((s) => s.lagMaxMs),
    scrapes: samples.length,
    failures,
  };
}

/**
 * Scrapes the server's `/metrics` on an interval. It keeps each resource sample (CPU, RSS, heap, event-loop lag)
 * and the first and last full scrape, so histograms and counters can be turned into run-long deltas.
 */
export class MetricsScraper {
  readonly samples: ResourceSample[] = [];
  first: Sample[] | null = null;
  last: Sample[] | null = null;
  failures = 0;
  private previous: { t: number; cpuSeconds: number } | null = null;
  private running = false;
  private loop: Promise<void> = Promise.resolve();

  constructor(
    private readonly url: string,
    private readonly clock: Clock,
    private readonly startMs: number,
    private readonly intervalMs = 2_000,
    private readonly fetcher: Fetcher = fetchText,
  ) {}

  /** One scrape now. Returns the sample, or null when the server did not answer. */
  async scrapeOnce(): Promise<ResourceSample | null> {
    try {
      const text = await this.fetcher(this.url);
      const samples = parseProm(text);
      const t = this.clock.now() - this.startMs;
      const { sample, cpuSeconds } = resourceSampleOf(samples, t, this.previous);
      this.previous = { t, cpuSeconds };
      this.first ??= samples;
      this.last = samples;
      this.samples.push(sample);
      return sample;
    } catch {
      this.failures++;
      return null;
    }
  }

  start(): void {
    this.running = true;
    this.loop = (async (): Promise<void> => {
      while (this.running) {
        await this.scrapeOnce();
        await this.clock.sleep(this.intervalMs);
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
    await this.scrapeOnce();
  }

  /** Run-clock time of the first scrape at which the counter had grown past its value at `afterT`, or null. */
  firstGrowth(counter: 'softConflates' | 'slowConsumers', afterT: number): number | null {
    const base = [...this.samples].reverse().find((s) => s.t <= afterT)?.[counter] ?? this.samples[0]?.[counter] ?? 0;
    return this.samples.find((s) => s.t > afterT && s[counter] > base)?.t ?? null;
  }

  report(): ResourceReport {
    return summarizeResources(this.samples, this.failures);
  }
}
