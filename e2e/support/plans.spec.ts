import { describe, expect, it, vi } from 'vitest';
import type { Faults } from './faults';
import { SMOKE_DOWN_MS, dropSchedule, performDrop, pickBetween } from './plans';

describe('dropSchedule', () => {
  it('rotates clean, 3s, 10s at fixed intervals', () => {
    const plan = dropSchedule(10, 30_000, 20_000);
    expect(plan).toHaveLength(10);
    expect(plan.slice(0, 4)).toEqual([
      { atMs: 20_000, kind: 'clean' },
      { atMs: 50_000, kind: 'down3' },
      { atMs: 80_000, kind: 'down10' },
      { atMs: 110_000, kind: 'clean' },
    ]);
    expect(plan.at(-1)?.atMs).toBe(290_000);
    expect(new Set(plan.map((p) => p.kind)).size).toBe(3);
  });
});

describe('performDrop', () => {
  const fakeFaults = (): Faults =>
    ({ dropClean: vi.fn(() => Promise.resolve()), down: vi.fn(() => Promise.resolve()) }) as unknown as Faults;

  it('maps each kind to the fault call', async () => {
    const faults = fakeFaults();
    await performDrop(faults, 'clean');
    await performDrop(faults, 'down3');
    await performDrop(faults, 'down10');
    expect(faults.dropClean).toHaveBeenCalledTimes(1);
    expect(vi.mocked(faults.down).mock.calls).toEqual([[3000], [10_000]]);
    await performDrop(faults, 'down10', SMOKE_DOWN_MS);
    expect(vi.mocked(faults.down).mock.calls.at(-1)).toEqual([5000]);
  });
});

describe('pickBetween', () => {
  it('stays in range and is repeatable', () => {
    expect(pickBetween(() => 0, 2000, 5000)).toBe(2000);
    expect(pickBetween(() => 1, 2000, 5000)).toBe(5000);
    expect(pickBetween(() => 0.5, 2000, 5000)).toBe(3500);
  });
});
