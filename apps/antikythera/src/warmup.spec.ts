import { describe, expect, it, vi } from 'vitest';
import { QueryEngine } from './query/engine.js';
import { makeStore } from './testing/orders.js';
import { WARM_BLOCKS, defaultWarmViews, loadWarmViews, warmUp } from './warmup.js';

const engineOf = (rows = 600): QueryEngine => {
  const store = makeStore(Array.from({ length: rows }, (_, i) => ({ traderId: i % 2 === 0 ? 'T1' : 'T2', createdAt: i, status: i % 3 === 0 ? ('LIVE' as const) : ('FILLED' as const) })));
  return new QueryEngine(store, { maxViews: 64, maxBytes: 1 << 26, maxBlockRows: 10_000 });
};

describe('defaultWarmViews', () => {
  it('has createdAt desc for everyone and for each trader, and everyone grouped by status', () => {
    const [flat, grouped] = defaultWarmViews();
    expect(flat?.traders).toEqual(['ALL', 'T1', 'T2', 'T3', 'T4', 'T5']);
    expect(flat?.req.sortModel).toEqual([{ colId: 'createdAt', sort: 'desc' }]);
    expect(grouped?.traders).toEqual(['ALL']);
    expect(grouped?.req.rowGroupCols).toEqual([{ id: 'status' }]);
  });
});

describe('loadWarmViews', () => {
  const request = { startRow: 0, endRow: 100, rowGroupCols: [], valueCols: [], groupKeys: [], sortModel: [{ colId: 'orderQty', sort: 'asc' }], filterModel: null };

  it('returns the defaults for "default"', () => {
    expect(loadWarmViews('default')).toEqual(defaultWarmViews());
  });

  it('reads a file of entries, with a trader list or "*"', () => {
    const read = vi.fn(() => JSON.stringify([{ traders: ['T1', 'T2'], req: request }, { traders: '*', req: request }]));
    const views = loadWarmViews('/config/warm.json', read);
    expect(read).toHaveBeenCalledWith('/config/warm.json');
    expect(views).toHaveLength(2);
    expect(views[1]?.traders).toBe('*');
  });

  it('says what is wrong with a file it cannot read or understand', () => {
    expect(() =>
      loadWarmViews('/nope.json', () => {
        throw new Error('ENOENT');
      }),
    ).toThrow(/WARM_VIEWS: cannot read \/nope\.json: ENOENT/);
    expect(() => loadWarmViews('x.json', () => 'not json')).toThrow(/cannot read x\.json/);
    expect(() => loadWarmViews('x.json', () => JSON.stringify([{ traders: [], req: request }]))).toThrow(/not a list of \{traders, req\}/);
    expect(() => loadWarmViews('x.json', () => JSON.stringify({ traders: '*' }))).toThrow(/not a list/);
  });
});

describe('warmUp', () => {
  it('builds each view and runs the rounds of blocks 0 to 4 over it', async () => {
    const engine = engineOf();
    const spy = vi.spyOn(engine, 'getRows');
    const report = await warmUp(engine, defaultWarmViews(), 3, { yieldToLoop: () => Promise.resolve() });
    // 6 flat views + 1 grouped view, 3 rounds of 5 blocks.
    expect(report).toMatchObject({ views: 7, requests: 7 * 3 * WARM_BLOCKS, failures: 0 });
    expect(spy).toHaveBeenCalledTimes(7 * 3 * WARM_BLOCKS);
    expect(report.ms).toBeGreaterThanOrEqual(0);
    const blocks = spy.mock.calls.slice(0, WARM_BLOCKS).map(([, req]) => [req.startRow, req.endRow]);
    expect(blocks).toEqual([[0, 100], [100, 200], [200, 300], [300, 400], [400, 500]]);
    expect(engine.stats().cache.views).toBeGreaterThanOrEqual(7);
  });

  it('warms a trader scope on its own, and "*" as everyone', async () => {
    const engine = engineOf();
    const spy = vi.spyOn(engine, 'getRows');
    const req = defaultWarmViews()[0]?.req ?? ({} as never);
    await warmUp(engine, [{ traders: ['T2'], req }, { traders: '*', req }], 1, { yieldToLoop: () => Promise.resolve() });
    expect([...new Set(spy.mock.calls.map(([trader]) => trader))]).toEqual(['T2', 'ALL']);
  });

  it('gives the event loop a turn after each view', async () => {
    const turn = vi.fn(() => Promise.resolve());
    await warmUp(engineOf(), defaultWarmViews(), 1, { yieldToLoop: turn });
    expect(turn).toHaveBeenCalledTimes(7);
  });

  it('counts requests the engine refuses, logs the first, and carries on', async () => {
    const log = vi.fn();
    const bad = { ...(defaultWarmViews()[0]?.req ?? ({} as never)), sortModel: [{ colId: 'nope', sort: 'asc' as const }] };
    const report = await warmUp(engineOf(), [{ traders: ['ALL'], req: bad }, ...defaultWarmViews().slice(1)], 1, { yieldToLoop: () => Promise.resolve(), log });
    expect(report.failures).toBe(WARM_BLOCKS);
    expect(report.requests).toBe(2 * WARM_BLOCKS);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ trader: 'ALL' }), 'warm-up request failed');
  });

  it('runs at least one round', async () => {
    const report = await warmUp(engineOf(), [{ traders: '*', req: defaultWarmViews()[1]?.req ?? ({} as never) }], 0, { yieldToLoop: () => Promise.resolve() });
    expect(report.requests).toBe(WARM_BLOCKS);
  });

  it('does nothing without views', async () => {
    expect(await warmUp(engineOf(), [], 3)).toMatchObject({ views: 0, requests: 0, failures: 0 });
  });
});
