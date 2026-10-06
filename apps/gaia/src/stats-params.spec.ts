import { describe, expect, it } from 'vitest';
import { loadStatsParams } from './stats-params.js';

describe('loadStatsParams', () => {
  it('uses seeder defaults', () => {
    const p = loadStatsParams({});
    expect(p).toMatchObject({ seed: 42, rows: 1_000_000 });
    expect(Math.abs(p.now - Date.now())).toBeLessThan(5000);
  });

  it('reads overrides', () => {
    expect(loadStatsParams({ SEED: '3', SEED_ROWS: '1_500', SEED_NOW: '2026-10-06T12:00:00Z' })).toEqual({
      seed: 3,
      rows: 1500,
      now: Date.UTC(2026, 9, 6, 12),
    });
  });

  it('rejects bad values', () => {
    expect(() => loadStatsParams({ SEED: 'x' })).toThrow();
    expect(() => loadStatsParams({ SEED_NOW: 'nope' })).toThrow();
  });
});
