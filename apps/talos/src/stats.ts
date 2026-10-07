export type Summary = { count: number; min: number; p50: number; p95: number; p99: number; max: number; mean: number };

/** Nearest-rank percentile of an ascending array: the smallest value with at least `p` percent of the samples at or below it. NaN when empty. */
export function percentile(sortedAsc: ArrayLike<number>, p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return Number.NaN;
  const rank = Math.min(n, Math.max(1, Math.ceil((p / 100) * n)));
  return sortedAsc[rank - 1] as number;
}

/** Percentiles, extremes and mean of the values, or null when there are none. */
export function summarize(values: readonly number[]): Summary | null {
  if (values.length === 0) return null;
  const sorted = Float64Array.from(values).sort();
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    count: sorted.length,
    min: sorted[0] as number,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] as number,
    mean: sum / sorted.length,
  };
}

export function median(values: readonly number[]): number {
  return percentile(Float64Array.from(values).sort(), 50);
}

/** Timestamped samples (`t` in ms on the run clock), so a summary can cover a window such as the stress period. */
export class SampleSet {
  private ts: number[] = [];
  private vs: number[] = [];

  add(t: number, value: number): void {
    this.ts.push(t);
    this.vs.push(value);
  }

  get count(): number {
    return this.vs.length;
  }

  /** Values with `from <= t < to`. */
  values(from = -Infinity, to = Infinity): number[] {
    if (from === -Infinity && to === Infinity) return [...this.vs];
    const out: number[] = [];
    for (let i = 0; i < this.vs.length; i++) {
      const t = this.ts[i] as number;
      if (t >= from && t < to) out.push(this.vs[i] as number);
    }
    return out;
  }

  summary(from = -Infinity, to = Infinity): Summary | null {
    return summarize(this.values(from, to));
  }
}

/** Min, median and max of a series (the server resource samples), or null when empty. */
export type Range = { min: number; median: number; max: number; samples: number };

export function rangeOf(values: readonly number[]): Range | null {
  if (values.length === 0) return null;
  const sorted = Float64Array.from(values).sort();
  return { min: sorted[0] as number, median: percentile(sorted, 50), max: sorted[sorted.length - 1] as number, samples: sorted.length };
}
