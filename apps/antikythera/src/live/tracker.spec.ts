import type { Order, SsrmRequest } from '@apeiron/logos';
import { describe, expect, it } from 'vitest';
import { QueryEngine } from '../query/engine.js';
import { routeKeyOf, type ViewChanges } from '../query/view.js';
import { applyOrders, applyUpdates } from '../testing/apply.js';
import { makeOrders, makeStore } from '../testing/orders.js';
import { ClientTracker } from './tracker.js';

const opts = { maxViews: 50, maxBytes: 1 << 30, maxBlockRows: 10_000, patchUnsubscribed: true, deferRebuilds: false };
const req = (extra: Partial<SsrmRequest> = {}): SsrmRequest => ({
  startRow: 0,
  endRow: 100,
  rowGroupCols: [],
  valueCols: [],
  groupKeys: [],
  sortModel: [],
  filterModel: null,
  ...extra,
});

const BASE: Partial<Order>[] = [
  { createdAt: 10, venue: 'EBS', orderQty: 1, notionalUsd: 10, status: 'LIVE' },
  { createdAt: 20, venue: 'LMAX', orderQty: 2, notionalUsd: 20, status: 'LIVE' },
  { createdAt: 30, venue: 'EBS', orderQty: 3, notionalUsd: 30, status: 'LIVE' },
  { createdAt: 40, venue: 'LMAX', orderQty: 4, notionalUsd: 40, status: 'FILLED' },
];

function world(max = 100): { store: ReturnType<typeof makeStore>; engine: QueryEngine; tracker: ClientTracker; get: (r: SsrmRequest, trader?: string) => void; collect: (changes: ViewChanges[], cs: Parameters<ClientTracker['collect']>[1]) => void } {
  const store = makeStore(BASE);
  const engine = new QueryEngine(store, opts);
  const tracker = new ClientTracker(max);
  const get = (r: SsrmRequest, trader = 'ALL'): void => {
    const res = engine.getRows(trader, r);
    if (!res.ok) throw new Error(res.code);
    tracker.record(res.value.track);
  };
  const collect = (changes: ViewChanges[], cs: Parameters<ClientTracker['collect']>[1]): void =>
    tracker.collect(changes.find((c) => c.view === tracker.view), cs);
  return { store, engine, tracker, get, collect };
}

describe('ClientTracker: updates', () => {
  it('sends changed fields plus orderId for tracked rows only', () => {
    const w = world();
    w.get(req({ startRow: 0, endRow: 2 }));
    const out = applyUpdates(w.store, w.engine, [
      { orderId: 'T0000004', marketMid: 5, filledQty: 9 },
      { orderId: 'T0000001', marketMid: 7, slippageBps: null },
    ]);
    w.collect(out.changes, out.cs);
    const delta = w.tracker.build(w.store, 123);
    expect(delta).toMatchObject({ t: 'delta', seq: 1, serverTs: 123, adds: [], dirtyRoutes: [], newAbove: 0 });
    expect(delta?.updates).toEqual([{ route: [], rows: [{ orderId: 'T0000004', marketMid: 5, filledQty: 9 }] }]);
  });

  it('includes only rows in tracked blocks', () => {
    const w = world();
    w.get(req({ startRow: 0, endRow: 2 }));
    expect(w.tracker.trackedRows).toBe(2);
    const out = applyUpdates(w.store, w.engine, [
      { orderId: 'T0000004', marketMid: 5 },
      { orderId: 'T0000002', marketMid: 8 },
    ]);
    w.collect(out.changes, out.cs);
    const delta = w.tracker.build(w.store, 1);
    expect(delta?.updates).toEqual([{ route: [], rows: [{ orderId: 'T0000004', marketMid: 5 }] }]);
  });

  it('skips the delta entirely when nothing relevant changed', () => {
    const w = world();
    w.get(req({ startRow: 0, endRow: 1 }));
    const out = applyUpdates(w.store, w.engine, [{ orderId: 'T0000001', marketMid: 5 }]);
    w.collect(out.changes, out.cs);
    expect(w.tracker.build(w.store, 1)).toBeNull();
    expect(w.tracker.hasPending).toBe(false);
  });

  it('sends updates for rows whose change is also structural (cells keep ticking until the refresh)', () => {
    const w = world();
    w.get(req({ sortModel: [{ colId: 'orderQty', sort: 'asc' }] }));
    const out = applyUpdates(w.store, w.engine, [{ orderId: 'T0000001', orderQty: 99 }]);
    w.collect(out.changes, out.cs);
    const delta = w.tracker.build(w.store, 1);
    expect(delta?.dirtyRoutes).toEqual([[]]);
    expect(delta?.updates).toEqual([{ route: [], rows: [{ orderId: 'T0000001', orderQty: 99 }] }]);
  });

  it('accumulates while held back, keeping the latest values and the union of fields', () => {
    const w = world();
    w.get(req());
    const a = applyUpdates(w.store, w.engine, [{ orderId: 'T0000001', marketMid: 1 }]);
    w.collect(a.changes, a.cs);
    const b = applyUpdates(w.store, w.engine, [{ orderId: 'T0000001', marketMid: 2, filledQty: 5 }, { orderId: 'T0000002', marketMid: 3 }]);
    w.collect(b.changes, b.cs);
    const delta = w.tracker.build(w.store, 1);
    expect(delta?.updates).toEqual([
      { route: [], rows: [{ orderId: 'T0000001', marketMid: 2, filledQty: 5 }, { orderId: 'T0000002', marketMid: 3 }] },
    ]);
    expect(w.tracker.build(w.store, 2)).toBeNull();
  });

  it('numbers deltas in sequence', () => {
    const w = world();
    w.get(req());
    for (const v of [1, 2, 3]) {
      const out = applyUpdates(w.store, w.engine, [{ orderId: 'T0000001', marketMid: v }]);
      w.collect(out.changes, out.cs);
      expect(w.tracker.build(w.store, v)?.seq).toBe(v);
    }
  });
});

describe('ClientTracker: adds, dirty routes and counts', () => {
  const newOrder = (extra: Partial<Order>): Order => makeOrders([{}, {}, {}, {}, { createdAt: 100, venue: 'EBS', status: 'LIVE', ...extra }]).slice(4)[0] as Order;

  it('sends new orders as adds at index 0 on a createdAt desc view whose top block is tracked', () => {
    const w = world();
    w.get(req());
    const out = applyOrders(w.store, w.engine, [newOrder({})]);
    w.collect(out.changes, out.cs);
    const delta = w.tracker.build(w.store, 1);
    expect(delta?.adds).toHaveLength(1);
    expect(delta?.adds[0]).toMatchObject({ route: [], addIndex: 0 });
    expect(delta?.adds[0]?.rows[0]?.orderId).toBe('T0000005');
    expect(Object.keys(delta?.adds[0]?.rows[0] ?? {})).toHaveLength(50);
    expect(delta?.dirtyRoutes).toEqual([]);
    expect(delta?.rowCounts).toEqual([{ route: [], rowCount: 5 }]);
    expect(delta?.updates).toEqual([]);
  });

  it('puts several new orders in one add, newest first, and later changes to them go out as updates', () => {
    const w = world();
    w.get(req());
    const rows = makeOrders([{}, {}, {}, {}, { createdAt: 100 }, { createdAt: 101 }]).slice(4);
    const out = applyOrders(w.store, w.engine, rows);
    w.collect(out.changes, out.cs);
    const delta = w.tracker.build(w.store, 1);
    expect(delta?.adds[0]?.rows.map((r) => r.createdAt)).toEqual([101, 100]);
    const next = applyUpdates(w.store, w.engine, [{ orderId: 'T0000006', marketMid: 4 }]);
    w.collect(next.changes, next.cs);
    expect(w.tracker.build(w.store, 2)?.updates).toEqual([{ route: [], rows: [{ orderId: 'T0000006', marketMid: 4 }] }]);
  });

  it('counts newAbove only for rows inserted above the last requested top row', () => {
    const atTop = world();
    atTop.get(req());
    const a = applyOrders(atTop.store, atTop.engine, [newOrder({})]);
    atTop.collect(a.changes, a.cs);
    expect(atTop.tracker.build(atTop.store, 1)?.newAbove).toBe(0);

    const scrolled = world();
    scrolled.get(req());
    scrolled.get(req({ startRow: 100, endRow: 200 }));
    expect(scrolled.tracker.rootTop).toBe(100);
    const b = applyOrders(scrolled.store, scrolled.engine, [newOrder({})]);
    scrolled.collect(b.changes, b.cs);
    expect(scrolled.tracker.build(scrolled.store, 1)?.newAbove).toBe(1);
  });

  it('marks the route dirty instead when the top block is not tracked', () => {
    const w = world();
    w.get(req({ startRow: 100, endRow: 200 }));
    const out = applyOrders(w.store, w.engine, [newOrder({})]);
    w.collect(out.changes, out.cs);
    const delta = w.tracker.build(w.store, 1);
    expect(delta?.adds).toEqual([]);
    expect(delta?.dirtyRoutes).toEqual([[]]);
  });

  it('marks the route dirty for any sort other than exactly createdAt desc', () => {
    const w = world();
    w.get(req({ sortModel: [{ colId: 'orderQty', sort: 'desc' }] }));
    const out = applyOrders(w.store, w.engine, [newOrder({ orderQty: 50 })]);
    w.collect(out.changes, out.cs);
    const delta = w.tracker.build(w.store, 1);
    expect(delta?.adds).toEqual([]);
    expect(delta?.dirtyRoutes).toEqual([[]]);
    expect(delta?.rowCounts).toEqual([{ route: [], rowCount: 5 }]);
  });

  it('also treats createdAt asc as dirty', () => {
    const w = world();
    w.get(req({ sortModel: [{ colId: 'createdAt', sort: 'asc' }] }));
    const out = applyOrders(w.store, w.engine, [newOrder({})]);
    w.collect(out.changes, out.cs);
    expect(w.tracker.build(w.store, 1)?.adds).toEqual([]);
  });

  it('ignores new orders that do not pass the view filter', () => {
    const w = world();
    w.get(req({ filterModel: { venue: { filterType: 'set', values: ['LMAX'] } } }));
    const out = applyOrders(w.store, w.engine, [newOrder({ venue: 'EBS' })]);
    w.collect(out.changes, out.cs);
    expect(w.tracker.build(w.store, 1)).toBeNull();
  });

  it('reports a changed row count for a row leaving the filter, with the route dirty', () => {
    const w = world();
    w.get(req({ filterModel: { venue: { filterType: 'set', values: ['EBS'] } } }));
    const out = applyUpdates(w.store, w.engine, [{ orderId: 'T0000001', venue: 'LMAX' }]);
    w.collect(out.changes, out.cs);
    const delta = w.tracker.build(w.store, 1);
    expect(delta?.dirtyRoutes).toEqual([[]]);
    expect(delta?.rowCounts).toEqual([{ route: [], rowCount: 1 }]);
  });

  it('reports row counts only for tracked routes whose count changed', () => {
    const w = world();
    const grouped = req({
      rowGroupCols: [{ id: 'venue', field: 'venue' }, { id: 'status', field: 'status' }],
      valueCols: [{ id: 'notionalUsd', field: 'notionalUsd', aggFunc: 'sum' }],
    });
    w.get({ ...grouped, groupKeys: [] });
    w.get({ ...grouped, groupKeys: ['EBS'] });
    const out = applyOrders(w.store, w.engine, [newOrder({ venue: 'EBS', status: 'PAUSED', notionalUsd: 10 })]);
    w.collect(out.changes, out.cs);
    const delta = w.tracker.build(w.store, 1);
    expect(delta?.rowCounts).toEqual([{ route: ['EBS'], rowCount: 2 }]);
    expect(delta?.dirtyRoutes).toEqual([['EBS']]);
    expect(delta?.groupUpdates).toEqual([{ route: [], rows: [{ venue: 'EBS', childCount: 3, notionalUsd: 50 }] }]);
  });
});

describe('ClientTracker: rows pushed down by many adds', () => {
  it('keeps sending updates for rows the client still holds after more than MAX_ADDED_ROWS new orders landed above them', () => {
    const w = world();
    w.get(req());
    const total = 700;
    const created = makeOrders([{}, {}, {}, {}, ...Array.from({ length: total }, (_, i) => ({ createdAt: 100 + i, venue: 'EBS' as const, status: 'LIVE' as const }))]).slice(4);
    for (const order of created) {
      const out = applyOrders(w.store, w.engine, [order]);
      w.collect(out.changes, out.cs);
      w.tracker.build(w.store, 1);
    }
    // The four original rows are now at positions 700 to 703, still in the client's cache, so they must stay tracked.
    const out = applyUpdates(w.store, w.engine, [{ orderId: 'T0000001', marketMid: 42 }]);
    w.collect(out.changes, out.cs);
    const delta = w.tracker.build(w.store, 2);
    const updated = delta?.updates.flatMap((u) => u.rows.map((r) => r.orderId)) ?? [];
    const refreshed = delta?.dirtyRoutes.length ?? 0;
    expect(updated.includes('T0000001') || refreshed > 0).toBe(true);
    expect(updated).toContain('T0000001');
  });

  it('asks the client to reload the route once adds outgrow what it can hold, instead of silently untracking rows', () => {
    const w = world();
    w.get(req());
    const total = 2100;
    const created = makeOrders([{}, {}, {}, {}, ...Array.from({ length: total }, (_, i) => ({ createdAt: 100 + i, venue: 'EBS' as const, status: 'LIVE' as const }))]).slice(4);
    let firstDirty = -1;
    for (const [i, order] of created.entries()) {
      const out = applyOrders(w.store, w.engine, [order]);
      w.collect(out.changes, out.cs);
      const delta = w.tracker.build(w.store, 1);
      if (firstDirty < 0 && (delta?.dirtyRoutes.length ?? 0) > 0) firstDirty = i;
    }
    expect(firstDirty).toBeGreaterThanOrEqual(1990);
    expect(firstDirty).toBeLessThan(2010);
  });
});

describe('ClientTracker: a reload of a block that adds pushed rows out of', () => {
  it('keeps following the rows pushed past its end, which the grid still holds', () => {
    const w = world();
    w.get(req({ startRow: 0, endRow: 3 }));
    const created = makeOrders([{}, {}, {}, {}, { createdAt: 100 }, { createdAt: 101 }]).slice(4);
    const out = applyOrders(w.store, w.engine, created);
    w.collect(out.changes, out.cs);
    w.tracker.build(w.store, 1);
    // The grid reloads block 0 (three rows: the two new orders and the old top). The old rows 2 and 3 now sit past its end.
    w.get(req({ startRow: 0, endRow: 3 }));
    const next = applyUpdates(w.store, w.engine, [{ orderId: 'T0000002', marketMid: 9 }, { orderId: 'T0000003', marketMid: 8 }]);
    w.collect(next.changes, next.cs);
    const updated = w.tracker.build(w.store, 2)?.updates.flatMap((u) => u.rows.map((r) => r.orderId)) ?? [];
    expect(updated.sort()).toEqual(['T0000002', 'T0000003']);
  });

  it('does not grow without bound over repeated reloads', () => {
    const w = world();
    w.get(req({ startRow: 0, endRow: 3 }));
    for (let i = 0; i < 40; i += 1) {
      const rows = makeOrders([{}, {}, {}, {}, ...Array.from({ length: 20 }, (_, k) => ({ createdAt: 1000 + i * 20 + k }))]).slice(4);
      const out = applyOrders(w.store, w.engine, rows.map((r, k) => ({ ...r, orderId: `N${i}_${k}` })));
      w.collect(out.changes, out.cs);
      w.tracker.build(w.store, i);
      w.get(req({ startRow: 0, endRow: 3 }));
    }
    expect(w.tracker.trackedRows).toBeLessThanOrEqual(3 + 200);
  });
});

describe('ClientTracker: groups', () => {
  const grouped = (extra: Partial<SsrmRequest> = {}): SsrmRequest =>
    req({
      rowGroupCols: [{ id: 'venue', field: 'venue' }, { id: 'status', field: 'status' }],
      valueCols: [{ id: 'notionalUsd', field: 'notionalUsd', aggFunc: 'sum' }],
      ...extra,
    });

  it('sends changed aggregates of tracked group rows as groupUpdates', () => {
    const w = world();
    w.get(grouped());
    const out = applyUpdates(w.store, w.engine, [{ orderId: 'T0000001', notionalUsd: 110 }]);
    w.collect(out.changes, out.cs);
    const delta = w.tracker.build(w.store, 1);
    expect(delta?.groupUpdates).toEqual([{ route: [], rows: [{ venue: 'EBS', childCount: 2, notionalUsd: 140 }] }]);
    expect(delta?.dirtyRoutes).toEqual([]);
  });

  it('marks a group route dirty when groups appear, disappear or reorder', () => {
    const w = world();
    w.get(grouped());
    const out = applyUpdates(w.store, w.engine, [{ orderId: 'T0000001', venue: 'FXALL' }]);
    w.collect(out.changes, out.cs);
    const delta = w.tracker.build(w.store, 1);
    expect(delta?.dirtyRoutes).toEqual([[]]);
    expect(delta?.rowCounts).toEqual([{ route: [], rowCount: 3 }]);
  });

  it('only sends group rows the client actually holds', () => {
    const w = world();
    w.get(grouped({ startRow: 0, endRow: 1 }));
    const out = applyUpdates(w.store, w.engine, [{ orderId: 'T0000002', notionalUsd: 99 }]);
    w.collect(out.changes, out.cs);
    expect(w.tracker.build(w.store, 1)).toBeNull();
  });

  it('tracks nested routes: updates carry their route and a leaf move is a dirty leaf route', () => {
    const w = world();
    w.get(grouped({ groupKeys: ['EBS'] }));
    w.get(grouped({ groupKeys: ['EBS', 'LIVE'] }));
    const out = applyUpdates(w.store, w.engine, [{ orderId: 'T0000001', marketMid: 3 }]);
    w.collect(out.changes, out.cs);
    expect(w.tracker.build(w.store, 1)?.updates).toEqual([{ route: ['EBS', 'LIVE'], rows: [{ orderId: 'T0000001', marketMid: 3 }] }]);
    const move = applyUpdates(w.store, w.engine, [{ orderId: 'T0000001', status: 'FILLED' }]);
    w.collect(move.changes, move.cs);
    const delta = w.tracker.build(w.store, 2);
    expect(delta?.dirtyRoutes).toEqual(expect.arrayContaining([['EBS', 'LIVE'], ['EBS']]));
  });

  it('drops tracking for a route whose group disappeared', () => {
    const w = world();
    w.get(grouped({ groupKeys: ['LMAX'] }));
    expect(w.tracker.isTracking(routeKeyOf(['LMAX']))).toBe(true);
    const out = applyUpdates(w.store, w.engine, [{ orderId: 'T0000002', venue: 'EBS' }, { orderId: 'T0000004', venue: 'EBS' }]);
    w.collect(out.changes, out.cs);
    expect(w.tracker.isTracking(routeKeyOf(['LMAX']))).toBe(false);
  });
});

describe('ClientTracker: block bookkeeping', () => {
  it('replaces the tracked entry when the same block is requested again', () => {
    const w = world();
    w.get(req({ startRow: 0, endRow: 4 }));
    expect(w.tracker.trackedBlocks).toBe(1);
    expect(w.tracker.trackedRows).toBe(4);
    w.get(req({ startRow: 0, endRow: 2 }));
    expect(w.tracker.trackedBlocks).toBe(1);
    expect(w.tracker.trackedRows).toBe(2);
  });

  it('keeps at most maxBlocks blocks, dropping the least recently requested', () => {
    const w = world(2);
    w.get(req({ startRow: 0, endRow: 1 }));
    w.get(req({ startRow: 1, endRow: 2 }));
    w.get(req({ startRow: 2, endRow: 3 }));
    expect(w.tracker.trackedBlocks).toBe(2);
    expect(w.tracker.trackedRows).toBe(2);
    const out = applyUpdates(w.store, w.engine, [{ orderId: 'T0000004', marketMid: 1 }]);
    w.collect(out.changes, out.cs);
    expect(w.tracker.build(w.store, 1)).toBeNull();
    w.get(req({ startRow: 1, endRow: 2 }));
    w.get(req({ startRow: 3, endRow: 4 }));
    expect(w.tracker.trackedBlocks).toBe(2);
  });

  it('follows one view at a time and releases the old one', () => {
    const w = world();
    w.get(req());
    const first = w.tracker.view;
    expect(first?.refs).toBe(1);
    w.get(req({ sortModel: [{ colId: 'orderQty', sort: 'asc' }] }));
    expect(first?.refs).toBe(0);
    expect(w.tracker.view?.refs).toBe(1);
    expect(w.tracker.trackedBlocks).toBe(1);
    w.tracker.reset();
    expect(w.tracker.view).toBeNull();
    expect(w.tracker.trackedBlocks).toBe(0);
  });

  it('marks every tracked route dirty when its view was rebuilt', () => {
    const store = makeStore(BASE);
    const engine = new QueryEngine(store, { ...opts, structuralRebuildThreshold: 0 });
    const tracker = new ClientTracker(10);
    const r = engine.getRows('ALL', req({ sortModel: [{ colId: 'orderQty', sort: 'asc' }] }));
    if (!r.ok) throw new Error('x');
    tracker.record(r.value.track);
    const out = applyUpdates(store, engine, [{ orderId: 'T0000001', orderQty: 9 }]);
    expect(out.changes[0]?.rebuilt).toBe(true);
    tracker.collect(out.changes[0], out.cs);
    expect(tracker.build(store, 1)?.dirtyRoutes).toEqual([[]]);
  });

  it('does nothing without a view', () => {
    const w = world();
    expect(w.tracker.build(w.store, 1)).toBeNull();
    w.collect([], applyUpdates(w.store, w.engine, [{ orderId: 'T0000001', marketMid: 1 }]).cs);
    expect(w.tracker.hasPending).toBe(false);
  });
});

describe('ClientTracker.markAllDirty', () => {
  it('flags every tracked route for a refresh, as after a deferred rebuild', () => {
    const w = world();
    w.get(req());
    w.tracker.markAllDirty();
    expect(w.tracker.build(w.store, 1)?.dirtyRoutes).toEqual([[]]);
    expect(w.tracker.build(w.store, 2)).toBeNull();
  });
});

describe('ClientTracker srcTs', () => {
  const stamped = (w: ReturnType<typeof world>, updates: [string, Partial<Order>, number][]): ReturnType<typeof applyUpdates> => {
    const out = applyUpdates(w.store, w.engine, []);
    for (const [orderId, patch, ts] of updates) {
      const row = w.store.rowIndexOf(orderId) as number;
      const { changed, prev } = w.store.updateRow(row, patch);
      out.cs.noteUpdate(row, changed, prev, ts);
    }
    out.changes = w.engine.applyChanges(out.cs);
    return out;
  };

  it('is the earliest source timestamp of the rows the client holds', () => {
    const w = world();
    w.get(req({ startRow: 0, endRow: 2 }));
    const out = stamped(w, [['T0000004', { marketMid: 5 }, 900], ['T0000003', { marketMid: 6 }, 800], ['T0000001', { marketMid: 7 }, 100]]);
    w.collect(out.changes, out.cs);
    expect(w.tracker.build(w.store, 1_000)?.srcTs).toBe(800);
  });

  it('keeps the earliest across ticks the client was held back for', () => {
    const w = world();
    w.get(req({ startRow: 0, endRow: 2 }));
    w.collect([], stamped(w, [['T0000004', { marketMid: 5 }, 940]]).cs);
    w.collect([], stamped(w, [['T0000003', { marketMid: 6 }, 910]]).cs);
    w.collect([], stamped(w, [['T0000004', { marketMid: 7 }, 990]]).cs);
    expect(w.tracker.build(w.store, 1_000)?.srcTs).toBe(910);
  });

  it('uses the tick-wide earliest for structural changes the client must refresh', () => {
    const w = world();
    w.get(req({ sortModel: [{ colId: 'orderQty', sort: 'asc' }] }));
    const out = stamped(w, [['T0000002', { orderQty: 99 }, 850], ['T0000004', { marketMid: 1 }, 700]]);
    w.collect(out.changes, out.cs);
    expect(w.tracker.build(w.store, 1_000)).toMatchObject({ srcTs: 700, dirtyRoutes: [[]] });
  });

  it('is the send time for a refresh with no source event, and never later than it', () => {
    const w = world();
    w.get(req());
    w.tracker.markAllDirty();
    expect(w.tracker.build(w.store, 1_234)?.srcTs).toBe(1_234);
    w.collect([], stamped(w, [['T0000001', { marketMid: 1 }, 5_000]]).cs);
    expect(w.tracker.build(w.store, 1_234)?.srcTs).toBe(1_234);
  });
});
