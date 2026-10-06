import { describe, expect, it } from 'vitest';
import { computeStats, formatStats, generateStats, percentiles } from './stats.js';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

describe('percentiles', () => {
  it('computes order statistics', () => {
    const p = percentiles(Float64Array.from({ length: 100 }, (_, i) => i + 1));
    expect(p).toMatchObject({ min: 1, p50: 51, p99: 100, max: 100, mean: 50.5 });
  });

  it('handles empty input', () => {
    expect(percentiles(new Float64Array(0)).max).toBe(0);
  });
});

describe('generateStats', () => {
  const stats = generateStats(42, 20_000, NOW);

  it('counts rows by status including current orders', () => {
    expect(stats.total).toBe(20_000);
    expect(stats.liveCount).toBe(8);
    expect(stats.pendingCount).toBe(4);
    expect(Object.values(stats.byStatus).reduce((a, b) => a + b, 0)).toBe(20_000);
    expect(stats.weekendOrders).toBe(0);
  });

  it('is reproducible', () => {
    expect(generateStats(42, 20_000, NOW)).toEqual(stats);
  });

  it('formats markdown tables', () => {
    const text = formatStats(stats);
    expect(text).toContain('### Status');
    expect(text).toContain('| EURUSD |');
    expect(text).toContain('Total rows: 20,000');
  });

  it('handles an empty input', () => {
    const empty = computeStats([], 0);
    expect(empty.total).toBe(0);
    expect(empty.londonHoursShare).toBe(0);
  });
});
