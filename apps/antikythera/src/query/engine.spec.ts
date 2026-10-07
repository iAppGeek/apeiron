import { sampleOrders, type Order, type Row, type SsrmRequest } from '@apeiron/logos';
import { describe, expect, it } from 'vitest';
import { applyOrders } from '../testing/apply.js';
import { makeOrders, makeStore } from '../testing/orders.js';
import { SET_FILTER_VALUE_CAP, QueryEngine, type RowsResult } from './engine.js';

const req = (r: Partial<SsrmRequest> = {}): SsrmRequest => ({
  startRow: 0,
  endRow: 100,
  rowGroupCols: [],
  valueCols: [],
  groupKeys: [],
  sortModel: [],
  filterModel: null,
  ...r,
});
const opts = { maxViews: 8, maxBytes: 10_000_000, maxBlockRows: 1_000, patchUnsubscribed: true, deferRebuilds: false };

function rowsOk(engine: QueryEngine, trader: string, r: SsrmRequest): RowsResult {
  const res = engine.getRows(trader, r);
  if (!res.ok) throw new Error(`${res.code}: ${res.message}`);
  return res.value;
}

const data: Partial<Order>[] = [
  { traderId: 'T1', traderName: 'Alice', side: 'BUY', venue: 'EBS', orderQty: 10, notionalUsd: 100, createdAt: 1 },
  { traderId: 'T2', traderName: 'Ben', side: 'SELL', venue: 'EBS', orderQty: 20, notionalUsd: 200, createdAt: 2 },
  { traderId: 'T1', traderName: 'Alice', side: 'SELL', venue: 'LMAX', orderQty: 30, notionalUsd: 300, createdAt: 3 },
  { traderId: 'T1', traderName: 'Alice', side: 'BUY', venue: 'EBS', orderQty: 40, notionalUsd: 400, createdAt: 4 },
  { traderId: 'T2', traderName: 'Ben', side: 'BUY', venue: 'LMAX', orderQty: 50, notionalUsd: 500, createdAt: 5 },
];

describe('QueryEngine.getRows (flat)', () => {
  const engine = new QueryEngine(makeStore(data), opts);

  it('defaults to createdAt desc and returns full rows with an exact rowCount', () => {
    const r = rowsOk(engine, 'ALL', req());
    expect(r.rowCount).toBe(5);
    expect(r.rows.map((x) => x.createdAt)).toEqual([5, 4, 3, 2, 1]);
    expect(Object.keys(r.rows[0] as Row)).toHaveLength(50);
  });

  it('returns the requested block and keeps rowCount exact', () => {
    const r = rowsOk(engine, 'ALL', req({ startRow: 1, endRow: 3 }));
    expect(r.rows.map((x) => x.createdAt)).toEqual([4, 3]);
    expect(r.rowCount).toBe(5);
    expect(rowsOk(engine, 'ALL', req({ startRow: 4, endRow: 100 })).rows).toHaveLength(1);
    expect(rowsOk(engine, 'ALL', req({ startRow: 50, endRow: 60 })).rows).toEqual([]);
  });

  it('adjacent blocks neither overlap nor skip rows', () => {
    const a = rowsOk(engine, 'ALL', req({ startRow: 0, endRow: 2 }));
    const b = rowsOk(engine, 'ALL', req({ startRow: 2, endRow: 5 }));
    expect([...a.rows, ...b.rows].map((x) => x.createdAt)).toEqual([5, 4, 3, 2, 1]);
  });

  it('applies trader scope, filters and sort', () => {
    const r = rowsOk(
      engine,
      'T1',
      req({
        sortModel: [{ colId: 'orderQty', sort: 'asc' }],
        filterModel: { venue: { filterType: 'set', values: ['EBS'] } },
      }),
    );
    expect(r.rows.map((x) => x.orderQty)).toEqual([10, 40]);
    expect(r.rowCount).toBe(2);
  });

  it('serves an unknown trader as empty', () => {
    const r = rowsOk(engine, 'T9', req());
    expect(r).toMatchObject({ rows: [], rowCount: 0 });
  });

  it('reports built on the first request and reuses the view afterwards', () => {
    const e = new QueryEngine(makeStore(data), opts);
    expect(rowsOk(e, 'ALL', req()).built).toBe(true);
    expect(rowsOk(e, 'ALL', req({ startRow: 2, endRow: 4 })).built).toBe(false);
    expect(e.stats().cache).toMatchObject({ views: 1, hits: 1, misses: 1 });
  });

  it('shares one view between clients that differ only in key order', () => {
    const e = new QueryEngine(makeStore(data), opts);
    const f1 = { venue: { filterType: 'set', values: ['EBS'] }, orderQty: { filterType: 'number', type: 'greaterThan', filter: 1 } };
    const f2 = { orderQty: { filter: 1, type: 'greaterThan', filterType: 'number' }, venue: { values: ['EBS'], filterType: 'set' } };
    rowsOk(e, 'ALL', req({ filterModel: f1 }));
    expect(rowsOk(e, 'ALL', req({ filterModel: f2 })).built).toBe(false);
    expect(e.stats().cache.views).toBe(1);
  });

  it('returns validation errors with codes', () => {
    const e = new QueryEngine(makeStore(data), opts);
    const code = (r: SsrmRequest): string => {
      const res = e.getRows('ALL', r);
      return res.ok ? 'ok' : res.code;
    };
    expect(code(req({ pivotMode: true }))).toBe('UNSUPPORTED_PIVOT');
    expect(code(req({ valueCols: [{ id: 'orderQty', aggFunc: 'median' }] }))).toBe('UNSUPPORTED_AGG');
    expect(code(req({ filterModel: { orderQty: { filterType: 'bogus' } } }))).toBe('UNSUPPORTED_FILTER');
    expect(code(req({ endRow: 5_000 }))).toBe('BAD_REQUEST');
  });

  it('patches cached views in place when the store changes, instead of dropping them', () => {
    const store = makeStore(data);
    const e = new QueryEngine(store, opts);
    expect(rowsOk(e, 'ALL', req()).rowCount).toBe(5);
    applyOrders(store, e, makeOrders([{ orderId: 'Z9999999', createdAt: 99 }]));
    const r = rowsOk(e, 'ALL', req());
    expect(r.built).toBe(false);
    expect(r.rowCount).toBe(6);
    expect(r.rows[0]?.orderId).toBe('Z9999999');
  });

  it('reports the tracked block for live deltas', () => {
    const e = new QueryEngine(makeStore(data), opts);
    const r = rowsOk(e, 'ALL', req({ startRow: 1, endRow: 3 }));
    expect(r.track).toMatchObject({ route: [], routeKey: '', startRow: 1, kind: 'leaf' });
    expect(r.track.rowIdx).toHaveLength(2);
    const g = rowsOk(e, 'ALL', req({ rowGroupCols: [{ id: 'side' }], valueCols: [] }));
    expect(g.track).toMatchObject({ kind: 'group' });
    expect(g.track.labels).toEqual(g.rows.map((row) => row.side));
  });
});

describe('QueryEngine.getRows (grouped)', () => {
  const engine = new QueryEngine(makeStore(data), opts);
  const grouped = (r: Partial<SsrmRequest> = {}): SsrmRequest =>
    req({
      rowGroupCols: [{ id: 'traderName' }, { id: 'side' }],
      valueCols: [
        { id: 'orderQty', aggFunc: 'sum' },
        { id: 'notionalUsd', aggFunc: 'avg' },
      ],
      ...r,
    });

  it('returns group rows with childCount and aggregates, keys ascending by default', () => {
    const r = rowsOk(engine, 'ALL', grouped());
    expect(r.rowCount).toBe(2);
    expect(r.rows).toEqual([
      { traderName: 'Alice', childCount: 3, orderQty: 80, notionalUsd: 800 / 3 },
      { traderName: 'Ben', childCount: 2, orderQty: 70, notionalUsd: 350 },
    ]);
  });

  it('descends one level per group key', () => {
    const r = rowsOk(engine, 'ALL', grouped({ groupKeys: ['Alice'] }));
    expect(r.rowCount).toBe(2);
    expect(r.rows).toEqual([
      { side: 'BUY', childCount: 2, orderQty: 50, notionalUsd: 250 },
      { side: 'SELL', childCount: 1, orderQty: 30, notionalUsd: 300 },
    ]);
  });

  it('returns leaf rows under a full group path, sorted by the default createdAt desc', () => {
    const r = rowsOk(engine, 'ALL', grouped({ groupKeys: ['Alice', 'BUY'] }));
    expect(r.rowCount).toBe(2);
    expect(r.rows.map((x) => x.createdAt)).toEqual([4, 1]);
  });

  it('sorts group rows by an aggregate and by the group column', () => {
    const byAgg = rowsOk(engine, 'ALL', grouped({ sortModel: [{ colId: 'orderQty', sort: 'asc' }] }));
    expect(byAgg.rows.map((x) => x.traderName)).toEqual(['Ben', 'Alice']);
    const byKey = rowsOk(engine, 'ALL', grouped({ sortModel: [{ colId: 'ag-Grid-AutoColumn', sort: 'desc' }] }));
    expect(byKey.rows.map((x) => x.traderName)).toEqual(['Ben', 'Alice']);
    const byField = rowsOk(engine, 'ALL', grouped({ sortModel: [{ colId: 'traderName', sort: 'desc' }] }));
    expect(byField.rows.map((x) => x.traderName)).toEqual(['Ben', 'Alice']);
  });

  it('uses leaf-only sort entries for leaves and ignores them for group rows', () => {
    const sort = [{ colId: 'venue', sort: 'desc' as const }];
    const groups = rowsOk(engine, 'ALL', grouped({ sortModel: sort }));
    expect(groups.rows.map((x) => x.traderName)).toEqual(['Alice', 'Ben']);
    const leaves = rowsOk(engine, 'ALL', grouped({ sortModel: sort, groupKeys: ['Alice', 'BUY'] }));
    expect(leaves.rows.map((x) => x.venue)).toEqual(['EBS', 'EBS']);
  });

  it('applies trader scope and filters to groups', () => {
    const r = rowsOk(engine, 'T1', grouped({ filterModel: { side: { filterType: 'set', values: ['BUY'] } } }));
    expect(r.rows).toEqual([{ traderName: 'Alice', childCount: 2, orderQty: 50, notionalUsd: 250 }]);
  });

  it('returns an empty block for a group key that does not exist', () => {
    expect(rowsOk(engine, 'ALL', grouped({ groupKeys: ['Nobody'] }))).toMatchObject({ rows: [], rowCount: 0 });
    expect(rowsOk(engine, 'ALL', grouped({ groupKeys: ['Alice', 'SIDEWAYS'] }))).toMatchObject({ rows: [], rowCount: 0 });
  });

  it('pages group rows', () => {
    const r = rowsOk(engine, 'ALL', grouped({ startRow: 1, endRow: 2 }));
    expect(r.rows.map((x) => x.traderName)).toEqual(['Ben']);
    expect(r.rowCount).toBe(2);
  });

  it('keeps group keys containing separators distinct', () => {
    const odd = makeStore([
      { account: 'a\u0000b', venue: 'EBS' },
      { account: 'a', venue: 'LMAX' },
    ]);
    const e = new QueryEngine(odd, opts);
    const g = req({ rowGroupCols: [{ id: 'account' }, { id: 'venue' }] });
    expect(rowsOk(e, 'ALL', { ...g, groupKeys: ['a\u0000b'] }).rows).toMatchObject([{ venue: 'EBS' }]);
    expect(rowsOk(e, 'ALL', { ...g, groupKeys: ['a'] }).rows).toMatchObject([{ venue: 'LMAX' }]);
  });
});

describe('QueryEngine.setFilterValues', () => {
  const real = sampleOrders(400);
  const store = makeStore(real);
  const engine = new QueryEngine(store, opts);
  const values = (trader: string, col: string): string[] => {
    const r = engine.setFilterValues(trader, col);
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };

  it('returns distinct values sorted ascending', () => {
    const v = values('ALL', 'venue');
    expect(v).toEqual([...new Set(real.map((o) => o.venue))].sort());
  });

  it('is scoped to the trader', () => {
    const t1 = real.filter((o) => o.traderId === 'T1');
    expect(values('T1', 'currencyPair')).toEqual([...new Set(t1.map((o) => o.currencyPair))].sort());
    expect(values('T1', 'traderId')).toEqual(['T1']);
    expect(values('T9', 'venue')).toEqual([]);
  });

  it('serves repeat calls from a cache and refreshes when a dictionary gains a value', () => {
    const s = makeStore([{ venue: 'EBS' }]);
    const e = new QueryEngine(s, opts);
    const first = e.setFilterValues('ALL', 'venue');
    const second = e.setFilterValues('ALL', 'venue');
    expect(second.ok && first.ok && second.value === first.value).toBe(true);
    applyOrders(s, e, makeOrders([{ orderId: 'Z0000001', venue: 'LMAX' }]));
    expect(e.setFilterValues('ALL', 'venue')).toEqual({ ok: true, value: ['EBS', 'LMAX'] });
  });

  it('only allows set-filter columns', () => {
    const code = (col: string): string => {
      const r = engine.setFilterValues('ALL', col);
      return r.ok ? 'ok' : r.code;
    };
    expect(code('orderId')).toBe('UNSUPPORTED_COLUMN');
    expect(code('orderQty')).toBe('UNSUPPORTED_COLUMN');
    expect(code('createdAt')).toBe('UNSUPPORTED_COLUMN');
    expect(code('nope')).toBe('UNKNOWN_COLUMN');
    expect(code('status')).toBe('ok');
  });

  it('caps the list at 5,000 values', () => {
    expect(SET_FILTER_VALUE_CAP).toBe(5_000);
  });
});

describe('QueryEngine caches', () => {
  it('evicts under the view cap and clears on demand', () => {
    const e = new QueryEngine(makeStore(data), { ...opts, maxViews: 2 });
    for (const colId of ['orderQty', 'venue', 'side']) {
      rowsOk(e, 'ALL', req({ sortModel: [{ colId, sort: 'asc' }] }));
    }
    expect(e.stats().cache.views).toBe(2);
    expect(e.stats().cache.evictions).toBe(1);
    e.clearCaches();
    expect(e.stats().cache.views).toBe(0);
  });
});
