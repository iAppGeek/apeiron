import { describe, expect, it } from 'vitest';
import { SampleSet, median, percentile, rangeOf, summarize } from './stats.js';

describe('percentile (nearest rank)', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);

  it('takes the smallest value with at least p percent of the samples at or below it', () => {
    expect(percentile(hundred, 50)).toBe(50);
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile(hundred, 99)).toBe(99);
    expect(percentile(hundred, 100)).toBe(100);
  });

  it('gives p99 of 1000 samples as the 990th, so one outlier in 1000 does not move it', () => {
    const v = Array.from({ length: 1000 }, (_, i) => i + 1);
    v[999] = 1_000_000;
    expect(percentile(v, 99)).toBe(990);
    expect(percentile(v, 100)).toBe(1_000_000);
  });

  it('handles tiny inputs', () => {
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([1, 2], 50)).toBe(1);
    expect(percentile([1, 2], 51)).toBe(2);
    expect(percentile([], 50)).toBeNaN();
  });
});

describe('summarize', () => {
  it('sorts, then reports count, extremes, percentiles and mean', () => {
    const s = summarize([5, 1, 3, 2, 4]);
    expect(s).toEqual({ count: 5, min: 1, p50: 3, p95: 5, p99: 5, max: 5, mean: 3 });
  });

  it('is null without samples', () => {
    expect(summarize([])).toBeNull();
  });

  it('does not reorder the caller array', () => {
    const v = [3, 1, 2];
    summarize(v);
    expect(v).toEqual([3, 1, 2]);
  });
});

describe('SampleSet', () => {
  it('summarises a time window with from inclusive and to exclusive', () => {
    const s = new SampleSet();
    for (let t = 0; t < 10; t++) s.add(t * 1000, t);
    expect(s.count).toBe(10);
    expect(s.values(2000, 5000)).toEqual([2, 3, 4]);
    expect(s.summary(5000)?.min).toBe(5);
    expect(s.summary(-Infinity, 3000)?.max).toBe(2);
    expect(s.summary(20_000)).toBeNull();
  });
});

describe('median and rangeOf', () => {
  it('reports min, median and max', () => {
    expect(median([9, 1, 5])).toBe(5);
    expect(rangeOf([4, 8, 2, 6])).toEqual({ min: 2, median: 4, max: 8, samples: 4 });
    expect(rangeOf([])).toBeNull();
  });
});
