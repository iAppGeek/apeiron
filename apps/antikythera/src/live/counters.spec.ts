import { describe, expect, it } from 'vitest';
import { StatusCounters } from './counters.js';

describe('StatusCounters', () => {
  it('counts per trader and overall, and sums LIVE notional only', () => {
    const c = new StatusCounters();
    c.apply('T1', 'LIVE', 100, 1);
    c.apply('T1', 'FILLED', 50, 1);
    c.apply('T2', 'LIVE', 400, 1);
    c.apply('T2', 'PAUSED', 7, 1);
    expect(c.scoped('T1')).toMatchObject({ byStatus: { LIVE: 1, FILLED: 1, PAUSED: 0, PENDING_START: 0, CANCELLED: 0 }, liveNotionalUsd: 100 });
    expect(c.scoped('T2').liveNotionalUsd).toBe(400);
    expect(c.scoped('ALL')).toMatchObject({ byStatus: { LIVE: 2, FILLED: 1, PAUSED: 1 }, liveNotionalUsd: 500 });
  });

  it('removes contributions and ignores unknown traders', () => {
    const c = new StatusCounters();
    c.apply('T1', 'LIVE', 100, 1);
    c.apply('T1', 'LIVE', 100, -1);
    c.apply('T1', 'FILLED', 5, 1);
    expect(c.scoped('T1')).toMatchObject({ byStatus: { LIVE: 0, FILLED: 1 }, liveNotionalUsd: 0 });
    expect(c.scoped('T9')).toEqual({ byStatus: { PENDING_START: 0, LIVE: 0, PAUSED: 0, FILLED: 0, CANCELLED: 0 }, liveNotionalUsd: 0 });
  });

  it('does not count a NaN notional and clears', () => {
    const c = new StatusCounters();
    c.apply('T1', 'LIVE', Number.NaN, 1);
    expect(c.scoped('T1').liveNotionalUsd).toBe(0);
    c.clear();
    expect(c.scoped('ALL').byStatus.LIVE).toBe(0);
  });
});
