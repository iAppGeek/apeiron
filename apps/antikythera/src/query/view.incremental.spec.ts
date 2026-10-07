import type { Order, SsrmRequest } from '@apeiron/logos';
import { describe, expect, it } from 'vitest';
import { applyOrders, applyUpdates } from '../testing/apply.js';
import { makeOrders, makeStore } from '../testing/orders.js';
import { QueryEngine, type EngineOptions } from './engine.js';
import { routeKeyOf } from './view.js';

const opts: EngineOptions = { maxViews: 50, maxBytes: 1 << 30, maxBlockRows: 10_000 };

const req = (extra: Partial<SsrmRequest> = {}): SsrmRequest => ({
  startRow: 0,
  endRow: 1_000,
  rowGroupCols: [],
  valueCols: [],
  groupKeys: [],
  sortModel: [],
  filterModel: null,
  ...extra,
});

function setup(rows: Partial<Order>[], options: EngineOptions = opts): { store: ReturnType<typeof makeStore>; engine: QueryEngine } {
  const store = makeStore(rows);
  return { store, engine: new QueryEngine(store, options) };
}

function rows(engine: QueryEngine, r: SsrmRequest, trader = 'ALL'): Record<string, unknown>[] {
  const res = engine.getRows(trader, r);
  if (!res.ok) throw new Error(res.code);
  return res.value.rows;
}

describe('incremental views: flat', () => {
  const data: Partial<Order>[] = [
    { createdAt: 10, venue: 'EBS', orderQty: 1 },
    { createdAt: 20, venue: 'LMAX', orderQty: 2 },
    { createdAt: 30, venue: 'EBS', orderQty: 3 },
  ];

  it('reports a new row inserted at the top of the default sort with its final position', () => {
    const { store, engine } = setup(data);
    expect(rows(engine, req()).map((r) => r.createdAt)).toEqual([30, 20, 10]);
    const { changes } = applyOrders(store, engine, makeOrders([{}, {}, {}, { createdAt: 99 }, { createdAt: 98 }]).slice(3));
    const route = changes[0]?.routes.get('');
    expect(route).toMatchObject({ structural: false, countChanged: true, rowCount: 5 });
    expect(route?.inserts).toEqual([
      { row: 3, pos: 0 },
      { row: 4, pos: 1 },
    ]);
    expect(rows(engine, req()).map((r) => r.createdAt)).toEqual([99, 98, 30, 20, 10]);
    expect(changes[0]?.rebuilt).toBe(false);
  });

  it('marks a sort-key change structural and keeps the order right', () => {
    const { store, engine } = setup(data);
    rows(engine, req({ sortModel: [{ colId: 'orderQty', sort: 'asc' }] }));
    const { changes } = applyUpdates(store, engine, [{ orderId: 'T0000001', orderQty: 100 }]);
    expect(changes[0]?.routes.get('')).toMatchObject({ structural: true, countChanged: false, inserts: [] });
    expect(rows(engine, req({ sortModel: [{ colId: 'orderQty', sort: 'asc' }] })).map((r) => r.orderQty)).toEqual([2, 3, 100]);
  });

  it('leaves a view alone when only unrelated fields change', () => {
    const { store, engine } = setup(data);
    rows(engine, req({ sortModel: [{ colId: 'orderQty', sort: 'asc' }] }));
    const { changes } = applyUpdates(store, engine, [{ orderId: 'T0000002', marketMid: 5 }]);
    expect(changes[0]?.routes.size).toBe(0);
    expect(changes[0]?.rebuilt).toBe(false);
  });

  it('adds and removes rows as they flip in and out of a filter', () => {
    const { store, engine } = setup(data);
    const filtered = req({ filterModel: { venue: { filterType: 'set', values: ['EBS'] } } });
    expect(rows(engine, filtered).map((r) => r.createdAt)).toEqual([30, 10]);
    const flip = applyUpdates(store, engine, [{ orderId: 'T0000002', venue: 'EBS' }]);
    expect(flip.changes[0]?.routes.get('')).toMatchObject({ structural: true, countChanged: true, rowCount: 3 });
    expect(rows(engine, filtered).map((r) => r.createdAt)).toEqual([30, 20, 10]);
    applyUpdates(store, engine, [{ orderId: 'T0000001', venue: 'LMAX' }, { orderId: 'T0000003', venue: 'LMAX' }]);
    expect(rows(engine, filtered).map((r) => r.createdAt)).toEqual([20]);
  });

  it('picks up a set-filter value that only exists after a dictionary grows', () => {
    const { store, engine } = setup(data);
    const filtered = req({ filterModel: { venue: { filterType: 'set', values: ['NEWVENUE'] } } });
    expect(rows(engine, filtered)).toEqual([]);
    applyOrders(store, engine, makeOrders([{}, {}, {}, { venue: 'NEWVENUE' as Order['venue'], createdAt: 5 }]).slice(3));
    expect(rows(engine, filtered).map((r) => r.createdAt)).toEqual([5]);
  });

  it('keeps trader-scoped views in step with appended rows of that trader only', () => {
    const { store, engine } = setup([{ traderId: 'T1', createdAt: 1 }, { traderId: 'T2', createdAt: 2 }]);
    expect(engine.getRows('T1', req()).ok).toBe(true);
    const extra = makeOrders([{}, {}, { traderId: 'T1', createdAt: 3 }, { traderId: 'T2', createdAt: 4 }]).slice(2);
    applyOrders(store, engine, extra);
    expect(rows(engine, req(), 'T1').map((r) => r.createdAt)).toEqual([3, 1]);
    expect(rows(engine, req(), 'T2').map((r) => r.createdAt)).toEqual([4, 2]);
  });

  it('rebuilds a view when a tick has more structural changes than the threshold', () => {
    const { store, engine } = setup(data, { ...opts, structuralRebuildThreshold: 1 });
    rows(engine, req({ sortModel: [{ colId: 'orderQty', sort: 'asc' }] }));
    const { changes } = applyUpdates(store, engine, [
      { orderId: 'T0000001', orderQty: 50 },
      { orderId: 'T0000002', orderQty: 40 },
    ]);
    expect(changes[0]?.rebuilt).toBe(true);
    expect(rows(engine, req({ sortModel: [{ colId: 'orderQty', sort: 'asc' }] })).map((r) => r.orderQty)).toEqual([3, 40, 50]);
  });

  it('shares one identity array across unfiltered views without letting them mutate it', () => {
    const { store, engine } = setup(data);
    rows(engine, req());
    rows(engine, req({ sortModel: [{ colId: 'orderQty', sort: 'desc' }] }));
    expect(engine.stats().cache.views).toBe(2);
    expect([...engine.views()].every((v) => v.bytes > 0)).toBe(true);
    applyOrders(store, engine, makeOrders([{}, {}, {}, { createdAt: 7 }]).slice(3));
    expect(rows(engine, req()).map((r) => r.createdAt)).toEqual([30, 20, 10, 7]);
    expect(rows(engine, req({ sortModel: [{ colId: 'orderQty', sort: 'desc' }] })).length).toBe(4);
  });
});

describe('incremental views: grouped', () => {
  const data: Partial<Order>[] = [
    { venue: 'EBS', side: 'BUY', notionalUsd: 100, slippageBps: 1, createdAt: 1 },
    { venue: 'EBS', side: 'SELL', notionalUsd: 300, slippageBps: 3, createdAt: 2 },
    { venue: 'LMAX', side: 'BUY', notionalUsd: 200, slippageBps: null, createdAt: 3 },
  ];
  const grouped = (extra: Partial<SsrmRequest> = {}): SsrmRequest =>
    req({
      rowGroupCols: [{ id: 'venue', field: 'venue' }, { id: 'side', field: 'side' }],
      valueCols: [
        { id: 'notionalUsd', field: 'notionalUsd', aggFunc: 'sum' },
        { id: 'slippageBps', field: 'slippageBps', aggFunc: 'wavg' },
      ],
      ...extra,
    });

  it('adjusts sums and weighted averages from previous values and reports the changed groups', () => {
    const { store, engine } = setup(data);
    expect(rows(engine, grouped())).toEqual([
      { venue: 'EBS', childCount: 2, notionalUsd: 400, slippageBps: 2.5 },
      { venue: 'LMAX', childCount: 1, notionalUsd: 200, slippageBps: null },
    ]);
    const { changes } = applyUpdates(store, engine, [{ orderId: 'T0000001', notionalUsd: 200, slippageBps: 4 }]);
    const route = changes[0]?.routes.get('');
    expect(route?.labels).toEqual(new Set(['EBS']));
    expect(route).toMatchObject({ orderChanged: false, countChanged: false, rowCount: 2 });
    const after = rows(engine, grouped());
    expect(after[0]).toMatchObject({ venue: 'EBS', childCount: 2, notionalUsd: 500 });
    expect(after[0]?.slippageBps as number).toBeCloseTo((200 * 4 + 300 * 3) / 500, 9);
  });

  it('moves a row between groups, creating and removing buckets and reporting the order change', () => {
    const { store, engine } = setup(data);
    rows(engine, grouped());
    const { changes } = applyUpdates(store, engine, [{ orderId: 'T0000003', venue: 'FXALL' }]);
    const route = changes[0]?.routes.get('');
    expect(route).toMatchObject({ orderChanged: true, countChanged: false, rowCount: 2 });
    expect(changes[0]?.removedRoutes).toContain(routeKeyOf(['LMAX']));
    expect(rows(engine, grouped()).map((r) => r.venue)).toEqual(['EBS', 'FXALL']);
    applyOrders(store, engine, makeOrders([{}, {}, {}, { venue: 'ZZZ' as Order['venue'], notionalUsd: 5 }]).slice(3));
    expect(rows(engine, grouped()).map((r) => [r.venue, r.childCount])).toEqual([['EBS', 2], ['FXALL', 1], ['ZZZ', 1]]);
  });

  it('keeps nested routes in step: counts, leaves and child group rows', () => {
    const { store, engine } = setup(data);
    rows(engine, grouped({ groupKeys: ['EBS'] }));
    rows(engine, grouped({ groupKeys: ['EBS', 'BUY'] }));
    const { changes } = applyUpdates(store, engine, [{ orderId: 'T0000002', side: 'BUY' }]);
    expect(changes[0]?.routes.get(routeKeyOf(['EBS']))).toMatchObject({ orderChanged: true, countChanged: true, rowCount: 1 });
    expect(changes[0]?.removedRoutes).toContain(routeKeyOf(['EBS', 'SELL']));
    expect(rows(engine, grouped({ groupKeys: ['EBS'] }))).toEqual([
      { side: 'BUY', childCount: 2, notionalUsd: 400, slippageBps: 2.5 },
    ]);
    expect(changes[0]?.routes.get(routeKeyOf(['EBS', 'BUY']))).toMatchObject({ structural: true, countChanged: true, rowCount: 2 });
    expect(rows(engine, grouped({ groupKeys: ['EBS', 'BUY'] })).map((r) => r.createdAt)).toEqual([2, 1]);
  });

  it('reorders groups sorted by an aggregate when the aggregate changes', () => {
    const { store, engine } = setup(data);
    const sorted = grouped({ sortModel: [{ colId: 'notionalUsd', sort: 'desc' }] });
    expect(rows(engine, sorted).map((r) => r.venue)).toEqual(['EBS', 'LMAX']);
    const { changes } = applyUpdates(store, engine, [{ orderId: 'T0000003', notionalUsd: 5_000 }]);
    expect(changes[0]?.routes.get('')).toMatchObject({ orderChanged: true });
    expect(rows(engine, sorted).map((r) => r.venue)).toEqual(['LMAX', 'EBS']);
  });

  it('counts a row in the group whatever its nulls, and null aggregates when every value is null', () => {
    const { store, engine } = setup(data);
    rows(engine, grouped());
    applyUpdates(store, engine, [{ orderId: 'T0000001', slippageBps: null }, { orderId: 'T0000002', slippageBps: null }]);
    expect(rows(engine, grouped())[0]).toMatchObject({ venue: 'EBS', childCount: 2, slippageBps: null });
  });

  it('never needs the fallback rebuild during ordinary updates', () => {
    const { store, engine } = setup(data);
    rows(engine, grouped({ groupKeys: ['EBS', 'BUY'] }));
    applyUpdates(store, engine, [{ orderId: 'T0000001', venue: 'LMAX', createdAt: 77 }]);
    applyUpdates(store, engine, [{ orderId: 'T0000001', venue: 'EBS' }]);
    for (const v of engine.views()) expect(v.rebuiltAfterInconsistency).toBe(0);
  });
});
