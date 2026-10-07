export type LatencySnapshot = { p50: number | null; p95: number | null; count: number };

export type LatencyWindow = {
  record(now: number, ms: number): void;
  snapshot(now: number): LatencySnapshot;
  reset(): void;
};

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? null;
}

/** Rolling latency samples over the last `windowMs`, reported as p50 and p95. */
export function createLatencyWindow(windowMs: number): LatencyWindow {
  let samples: { at: number; ms: number }[] = [];

  const prune = (now: number): void => {
    const cutoff = now - windowMs;
    let drop = 0;
    while (drop < samples.length && (samples[drop] as { at: number }).at <= cutoff) drop += 1;
    if (drop > 0) samples = samples.slice(drop);
  };

  return {
    record(now, ms): void {
      samples.push({ at: now, ms });
      prune(now);
    },
    snapshot(now): LatencySnapshot {
      prune(now);
      const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
      return { p50: percentile(sorted, 50), p95: percentile(sorted, 95), count: sorted.length };
    },
    reset(): void {
      samples = [];
    },
  };
}

export type ClockOffsetEstimator = {
  /** One ping/pong exchange: client send time, the server's clock at the pong, client receive time. */
  addSample(sentAt: number, serverTs: number, receivedAt: number): void;
  /** Milliseconds to add to the client clock to get the server clock, or null before any sample. */
  offsetMs(): number | null;
  reset(): void;
};

/**
 * Estimates the server clock offset the NTP way: the server stamped its pong halfway through the round trip,
 * so `offset = serverTs - (sentAt + rtt / 2)`. The sample with the smallest round trip among the last
 * `maxSamples` wins, because it has the least room for asymmetric delay.
 */
export function createClockOffsetEstimator(maxSamples = 8): ClockOffsetEstimator {
  let samples: { rtt: number; offset: number }[] = [];
  return {
    addSample(sentAt, serverTs, receivedAt): void {
      const rtt = Math.max(0, receivedAt - sentAt);
      samples.push({ rtt, offset: serverTs - (sentAt + rtt / 2) });
      if (samples.length > maxSamples) samples = samples.slice(samples.length - maxSamples);
    },
    offsetMs(): number | null {
      let best: { rtt: number; offset: number } | null = null;
      for (const s of samples) {
        if (best === null || s.rtt < best.rtt) best = s;
      }
      return best === null ? null : best.offset;
    },
    reset(): void {
      samples = [];
    },
  };
}

/** Tick-to-screen latency of one delta: the time it was applied, on the server clock, minus the server timestamp. */
export function tickToScreenMs(appliedAt: number, srcTs: number, clockOffsetMs: number | null): number {
  return Math.max(0, appliedAt + (clockOffsetMs ?? 0) - srcTs);
}
