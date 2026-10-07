import { monitorEventLoopDelay } from 'node:perf_hooks';

type IntervalHistogram = ReturnType<typeof monitorEventLoopDelay>;

export type LagSnapshot = {
  /** Event-loop lag beyond the sampling resolution, in ms. */
  p50: number;
  p99: number;
  /** The 99.9th percentile: shows the stalls p99 hides. */
  p999: number;
  max: number;
  samples: number;
};

/**
 * Event-loop lag via `perf_hooks.monitorEventLoopDelay`. The histogram records timer intervals, so an
 * idle loop reads about the resolution; the snapshot subtracts it. The first sample after `reset()`
 * only sets the baseline, so let the loop turn once before the work you want to measure.
 */
export class LagMonitor {
  private readonly histogram: IntervalHistogram;

  constructor(private readonly resolutionMs = 10) {
    this.histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  }

  start(): void {
    this.histogram.enable();
  }

  stop(): void {
    this.histogram.disable();
  }

  reset(): void {
    this.histogram.reset();
  }

  snapshot(): LagSnapshot {
    const lag = (ns: number): number => Math.max(0, Math.round((ns / 1e6 - this.resolutionMs) * 10) / 10);
    return {
      p50: lag(this.histogram.percentile(50)),
      p99: lag(this.histogram.percentile(99)),
      p999: lag(this.histogram.percentile(99.9)),
      max: lag(this.histogram.max),
      samples: this.histogram.count,
    };
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `work` and returns its result with the event-loop lag seen while it ran. Lets the loop turn
 * before and after, so a stall is recorded even when `work` is synchronous.
 */
export async function withLagReport<T>(
  monitor: LagMonitor,
  work: () => Promise<T> | T,
  resolutionMs = 10,
): Promise<{ result: T; lag: LagSnapshot }> {
  await sleep(resolutionMs * 2 + 5);
  monitor.reset();
  await sleep(resolutionMs * 2 + 5);
  const result = await work();
  await sleep(resolutionMs * 2 + 5);
  return { result, lag: monitor.snapshot() };
}
