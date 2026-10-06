import { describe, expect, it } from 'vitest';
import { makeStore } from '../testing/orders.js';
import { RowBuf } from './row-buf.js';
import type { SortEntry } from './request.js';
import { View, type ViewSpec } from './view.js';

const store = makeStore([
  { side: 'BUY', venue: 'EBS', orderQty: 10, createdAt: 1 },
  { side: 'SELL', venue: 'EBS', orderQty: 20, createdAt: 2 },
  { side: 'BUY', venue: 'LMAX', orderQty: 30, createdAt: 3 },
]);
const entry = (colId: string, desc: boolean): SortEntry => ({ colId, field: colId === 'ag-Grid-AutoColumn' ? null : (colId as SortEntry['field']), desc });

function view(spec: Partial<ViewSpec>): View {
  return new View(store, { sort: [], groupCols: [], valueCols: [], filter: {}, traderId: 'ALL', ...spec });
}

describe('View', () => {
  it('counts filtered rows and tracks the bytes it owns', () => {
    const v = view({});
    expect(v.filteredCount).toBe(3);
    const base = v.bytes;
    expect(base).toBe(12);
    v.getBlock([], 0, 10);
    expect(v.bytes).toBe(24);
    v.getBlock([], 0, 10);
    expect(v.bytes).toBe(24);
  });

  it('does not count a shared identity array', () => {
    const identity = RowBuf.empty();
    identity.appendRange(0, store.size);
    const v = new View(store, { sort: [], groupCols: [], valueCols: [], filter: {}, traderId: 'ALL' }, identity);
    expect(v.filteredCount).toBe(3);
    expect(v.bytes).toBe(0);
  });

  it('applies a trader scope and a filter when it builds', () => {
    const scoped = view({ filter: { side: { filterType: 'set', values: ['BUY'] } } });
    expect(scoped.filteredCount).toBe(2);
    expect(scoped.getBlock([], 0, 10).rows.map((r) => r.createdAt)).toEqual([3, 1]);
  });

  it('serves leaf blocks in sort order, defaulting to createdAt desc', () => {
    expect(view({}).getBlock([], 0, 3).rows.map((r) => r.createdAt)).toEqual([3, 2, 1]);
    const asc = view({ sort: [entry('orderQty', false)] });
    expect(asc.getBlock([], 0, 2)).toMatchObject({ rowCount: 3 });
    expect(asc.getBlock([], 0, 2).rows.map((r) => r.orderQty)).toEqual([10, 20]);
  });

  it('builds group levels lazily per route and counts their memory', () => {
    const v = view({ groupCols: ['side', 'venue'], valueCols: [{ id: 'orderQty', field: 'orderQty', agg: 'sum' }] });
    const before = v.bytes;
    const top = v.getBlock([], 0, 10);
    expect(top.rowCount).toBe(2);
    expect(top.rows).toEqual([
      { side: 'BUY', childCount: 2, orderQty: 40 },
      { side: 'SELL', childCount: 1, orderQty: 20 },
    ]);
    expect(v.bytes).toBeGreaterThan(before);
    const child = v.getBlock(['BUY'], 0, 10);
    expect(child.rows).toEqual([
      { venue: 'EBS', childCount: 1, orderQty: 10 },
      { venue: 'LMAX', childCount: 1, orderQty: 30 },
    ]);
    expect(v.getBlock(['BUY', 'LMAX'], 0, 10).rows.map((r) => r.createdAt)).toEqual([3]);
  });

  it('returns nothing for a route that does not exist', () => {
    const v = view({ groupCols: ['side'] });
    expect(v.getBlock(['HOLD'], 0, 10)).toMatchObject({ rows: [], rowCount: 0 });
  });

  it('orders group rows from the sort entries (auto column, group column, aggregate)', () => {
    const base = { groupCols: ['side' as const], valueCols: [{ id: 'orderQty', field: 'orderQty' as const, agg: 'sum' as const }] };
    expect(view({ ...base, sort: [entry('ag-Grid-AutoColumn', true)] }).getBlock([], 0, 9).rows.map((r) => r.side)).toEqual(['SELL', 'BUY']);
    expect(view({ ...base, sort: [entry('orderQty', false)] }).getBlock([], 0, 9).rows.map((r) => r.side)).toEqual(['SELL', 'BUY']);
    expect(view({ ...base, sort: [entry('venue', false)] }).getBlock([], 0, 9).rows.map((r) => r.side)).toEqual(['BUY', 'SELL']);
  });
});
