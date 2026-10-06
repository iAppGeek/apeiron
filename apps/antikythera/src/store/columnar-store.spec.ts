import { COLUMNS, sampleOrders, type Order } from '@apeiron/logos';
import { describe, expect, it } from 'vitest';
import { ColumnarStore } from './columnar-store.js';

const orders = sampleOrders(300);

/** Rows may contain -0 in the source; the store normalises it to 0. */
const normalise = (o: Order): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === 0 ? 0 : v]));

function loaded(batch = 64, capacity?: number): ColumnarStore {
  const store = new ColumnarStore({ capacity });
  for (let i = 0; i < orders.length; i += batch) store.appendBatch(orders.slice(i, i + batch));
  return store;
}

describe('ColumnarStore', () => {
  it('round-trips every row and field, restoring null from NaN', () => {
    const store = loaded();
    expect(store.size).toBe(orders.length);
    for (let i = 0; i < orders.length; i++) {
      expect(store.rowAt(i)).toEqual(normalise(orders[i] as Order));
    }
    expect(orders.some((o) => o.avgFillPrice === null || o.limitPrice === null)).toBe(true);
  });

  it('stores nulls as NaN in the Float64 columns', () => {
    const store = loaded();
    const idx = orders.findIndex((o) => o.limitPrice === null);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(store.numberColumn('limitPrice')[idx]).toBeNaN();
    expect(store.rowAt(idx).limitPrice).toBeNull();
  });

  it('allocates typed arrays on SharedArrayBuffer', () => {
    const store = loaded();
    for (const col of store.columns.values()) {
      if (col.kind === 'number') expect(col.data.buffer).toBeInstanceOf(SharedArrayBuffer);
      if (col.kind === 'enum') expect(col.codes.buffer).toBeInstanceOf(SharedArrayBuffer);
    }
  });

  it('dictionary-encodes enums, keeps ids as strings, and indexes orderId', () => {
    const store = loaded();
    expect(store.column('status').kind).toBe('enum');
    expect(store.column('orderId').kind).toBe('string');
    expect(store.column('strategyParams').kind).toBe('string');
    expect(store.column('valueDate').kind).toBe('number');
    expect(store.enumColumn('side').dict.size).toBe(2);
    const o = orders[42] as Order;
    expect(store.rowIndexOf(o.orderId)).toBe(42);
    expect(store.rowIndexOf('nope')).toBeUndefined();
  });

  it('covers every column exactly once', () => {
    const store = loaded();
    expect([...store.columns.keys()].sort()).toEqual(COLUMNS.map((c) => c.field).sort());
  });

  it('grows past its capacity without losing data', () => {
    const store = loaded(25, 10);
    expect(store.capacity).toBeGreaterThanOrEqual(orders.length);
    expect(store.rowAt(299)).toEqual(normalise(orders[299] as Order));
    expect(store.rowAt(0)).toEqual(normalise(orders[0] as Order));
  });

  it('rejects duplicate ids and leaves the store unchanged', () => {
    const store = loaded();
    expect(() => store.appendBatch([orders[0] as Order])).toThrow(/Duplicate/);
    const fresh = { ...(orders[0] as Order), orderId: 'ZZZ1' };
    expect(() => store.appendBatch([fresh, fresh])).toThrow(/Duplicate/);
    expect(store.size).toBe(orders.length);
    expect(store.rowIndexOf('ZZZ1')).toBeUndefined();
  });

  it('tracks whether row order equals orderId order', () => {
    const store = loaded();
    expect(store.idsAscending).toBe(true);
    store.appendBatch([{ ...(orders[0] as Order), orderId: 'A-before-everything' }]);
    expect(store.idsAscending).toBe(false);
  });

  it('ignores empty batches and does not bump the layout version for plain appends', () => {
    const store = new ColumnarStore({ capacity: 4 });
    const v0 = store.layoutVersion;
    store.appendBatch([]);
    expect(store.size).toBe(0);
    store.appendBatch([orders[0] as Order]);
    expect(store.size).toBe(1);
    expect(store.layoutVersion).toBe(v0);
  });

  it('bumps the layout version when arrays are reallocated (growth, widening)', () => {
    const store = new ColumnarStore({ capacity: 2 });
    const v0 = store.layoutVersion;
    store.appendBatch(orders.slice(0, 5));
    expect(store.layoutVersion).toBeGreaterThan(v0);
    const v1 = store.layoutVersion;
    const many: Order[] = Array.from({ length: 300 }, (_, i) => ({
      ...(orders[0] as Order),
      orderId: `Z${String(i).padStart(4, '0')}`,
      account: `ACC-${i}`,
    }));
    store.appendBatch(many);
    expect(store.layoutVersion).toBeGreaterThan(v1);
  });

  it('widens enum codes beyond 256 distinct values', () => {
    const store = new ColumnarStore({ capacity: 2 });
    const many: Order[] = Array.from({ length: 300 }, (_, i) => ({
      ...(orders[0] as Order),
      orderId: `ID${String(i).padStart(4, '0')}`,
      account: `ACC-${i}`,
    }));
    store.appendBatch(many);
    const col = store.enumColumn('account');
    expect(col.codes).toBeInstanceOf(Uint16Array);
    expect(store.rowAt(299).account).toBe('ACC-299');
    expect(store.rowAt(0).account).toBe('ACC-0');
  });

  it('keeps earlier rows of the same batch when a dictionary widens mid-batch', () => {
    const store = new ColumnarStore({ capacity: 400 });
    const batch: Order[] = Array.from({ length: 300 }, (_, i) => ({
      ...(orders[0] as Order),
      orderId: `W${String(i).padStart(4, '0')}`,
      venue: `V${i}` as Order['venue'],
    }));
    store.appendBatch(batch);
    for (let i = 0; i < 300; i++) expect(store.rowAt(i).venue).toBe(`V${i}`);
  });

  it('widens across batches and combined with growth', () => {
    const store = new ColumnarStore({ capacity: 4 });
    const mk = (from: number, to: number): Order[] =>
      Array.from({ length: to - from }, (_, i) => ({
        ...(orders[0] as Order),
        orderId: `X${String(from + i).padStart(5, '0')}`,
        venue: `V${from + i}` as Order['venue'],
      }));
    store.appendBatch(mk(0, 200));
    store.appendBatch(mk(200, 700));
    store.appendBatch(mk(700, 1500));
    expect(store.enumColumn('venue').codes).toBeInstanceOf(Uint16Array);
    expect(store.capacity).toBeGreaterThanOrEqual(1500);
    for (let i = 0; i < 1500; i++) expect(store.rowAt(i).venue).toBe(`V${i}`);
    expect(store.rowAt(1499).orderId).toBe('X01499');
  });

  it('materialises a range and reports memory', () => {
    const store = loaded();
    const idx = Uint32Array.from([5, 1, 3]);
    expect(store.materialize(idx, 1, 10).map((r) => r.orderId)).toEqual([
      (orders[1] as Order).orderId,
      (orders[3] as Order).orderId,
    ]);
    const mem = store.memory();
    expect(mem.rows).toBe(300);
    expect(mem.columns).toHaveLength(50);
    expect(mem.typedUsedBytes).toBeGreaterThan(0);
    expect(mem.typedReservedBytes).toBeGreaterThanOrEqual(mem.typedUsedBytes);
    expect(mem.estimatedStringHeapBytes).toBeGreaterThan(0);
    expect(mem.columns.find((c) => c.field === 'status')?.dictionarySize).toBeGreaterThan(0);
  });

  it('ranks string columns, sharing a rank between equal strings and refreshing after appends', () => {
    const store = new ColumnarStore({ capacity: 4 });
    store.appendBatch(
      ['b', 'a', 'b', 'c'].map((strategyParams, i) => ({
        ...(orders[0] as Order),
        orderId: `R${i}`,
        strategyParams,
      })),
    );
    expect([...store.stringRank('strategyParams')]).toEqual([1, 0, 1, 2]);
    expect(store.stringRank('strategyParams')).toBe(store.stringRank('strategyParams'));
    store.appendBatch([{ ...(orders[0] as Order), orderId: 'R9', strategyParams: 'A' }]);
    expect([...store.stringRank('strategyParams')]).toEqual([2, 1, 2, 3, 0]);
  });

  it('throws on unknown or mistyped column access', () => {
    const store = loaded();
    expect(() => store.column('nope' as never)).toThrow();
    expect(() => store.numberColumn('status')).toThrow();
    expect(() => store.enumColumn('orderQty')).toThrow();
    expect(() => store.stringColumn('side')).toThrow();
  });

  describe('live updates', () => {
    it('updates fields in place and reports only what changed, with previous values', () => {
      const store = loaded();
      const before = store.rowAt(5);
      const result = store.updateRow(5, {
        filledQty: (before.filledQty as number) + 1,
        orderQty: before.orderQty as number,
        status: before.status === 'LIVE' ? 'PAUSED' : 'LIVE',
        strategyParams: 'x=1',
      });
      expect(result.changed.sort()).toEqual(['filledQty', 'status', 'strategyParams']);
      expect(result.prev).toEqual({ filledQty: before.filledQty, status: before.status, strategyParams: before.strategyParams });
      expect(store.rowAt(5).filledQty).toBe((before.filledQty as number) + 1);
      expect(store.rowAt(5).strategyParams).toBe('x=1');
      expect(store.rowAt(4)).toEqual(normalise(orders[4] as Order));
    });

    it('reports nothing for a no-op, ignores orderId and unknown keys, and treats NaN as null', () => {
      const store = loaded();
      const row = store.rowAt(2);
      expect(store.updateRow(2, { orderId: 'other', bogus: 1, filledQty: row.filledQty as number } as Partial<Order>)).toEqual({ changed: [], prev: {} });
      expect(store.rowAt(2).orderId).toBe((orders[2] as Order).orderId);
      const idx = orders.findIndex((o) => o.limitPrice === null);
      expect(store.updateRow(idx, { limitPrice: null })).toEqual({ changed: [], prev: {} });
      const to = store.updateRow(idx, { limitPrice: 1.5 });
      expect(to).toEqual({ changed: ['limitPrice'], prev: { limitPrice: null } });
      expect(store.updateRow(idx, { limitPrice: null })).toEqual({ changed: ['limitPrice'], prev: { limitPrice: 1.5 } });
      expect(store.rowAt(idx).limitPrice).toBeNull();
    });

    it('normalises -0 to 0', () => {
      const store = loaded();
      store.updateRow(0, { slippageUsd: 5 });
      expect(store.updateRow(0, { slippageUsd: -0 }).changed).toEqual(['slippageUsd']);
      expect(Object.is(store.numberColumn('slippageUsd')[0], 0)).toBe(true);
    });

    it('does not bump the layout version or global state for plain updates', () => {
      const store = loaded();
      const layout = store.layoutVersion;
      store.updateRow(1, { filledQty: 12345, status: 'PAUSED' });
      expect(store.layoutVersion).toBe(layout);
    });

    it('tracks dictionaries that gained a value, from updates and appends, and clears on read', () => {
      const store = loaded();
      store.takeDictionaryGrowth();
      store.updateRow(0, { venue: 'BRAND-NEW-VENUE' as Order['venue'] });
      store.appendBatch([{ ...(orders[0] as Order), orderId: 'ZZ-NEW', status: 'WEIRD' as Order['status'] }]);
      expect([...store.takeDictionaryGrowth()].sort()).toEqual(['status', 'venue']);
      expect(store.takeDictionaryGrowth().size).toBe(0);
      store.updateRow(0, { venue: 'BRAND-NEW-VENUE' as Order['venue'] });
      expect(store.takeDictionaryGrowth().size).toBe(0);
    });

    it('widens an enum column that outgrows 8-bit codes during updates and bumps the layout version', () => {
      const store = loaded();
      const layout = store.layoutVersion;
      for (let i = 0; i < 300; i++) store.updateRow(i % store.size, { account: `ACC-${i}` });
      expect(store.enumColumn('account').codes).toBeInstanceOf(Uint16Array);
      expect(store.layoutVersion).toBeGreaterThan(layout);
      expect(store.rowAt(299 % store.size).account).toBe('ACC-299');
    });

    it('upserts: an unknown id appends, a known id updates in place', () => {
      const store = loaded();
      const fresh: Order = { ...(orders[0] as Order), orderId: 'ZZ-UPSERT' };
      expect(store.upsert(fresh)).toEqual({ kind: 'append', row: orders.length });
      expect(store.size).toBe(orders.length + 1);
      const again = store.upsert({ ...fresh, filledQty: 99 });
      expect(again).toMatchObject({ kind: 'update', row: orders.length, changed: ['filledQty'] });
      expect(store.size).toBe(orders.length + 1);
      expect(store.upsert(fresh)).toMatchObject({ kind: 'update', changed: ['filledQty'], prev: { filledQty: 99 } });
    });

    it('builds typed orders and warns once when an append breaks ascending ids', () => {
      const broken: string[] = [];
      const store = new ColumnarStore({ capacity: 8, onAscendingBroken: (id) => broken.push(id) });
      store.appendBatch([{ ...(orders[0] as Order), orderId: 'B' }]);
      store.appendBatch([{ ...(orders[1] as Order), orderId: 'A' }]);
      store.appendBatch([{ ...(orders[2] as Order), orderId: '0' }]);
      expect(broken).toEqual(['A']);
      expect(store.idsAscending).toBe(false);
      expect(store.orderAt(0).orderId).toBe('B');
    });

    it('keeps ascending ids across live appends in order', () => {
      const broken: string[] = [];
      const store = new ColumnarStore({ capacity: 4, onAscendingBroken: (id) => broken.push(id) });
      for (let i = 0; i < 20; i++) store.appendBatch([{ ...(orders[i] as Order), orderId: `ALG${String(i).padStart(8, '0')}` }]);
      expect(store.idsAscending).toBe(true);
      expect(broken).toEqual([]);
    });
  });

  describe('string ranks under live changes', () => {
    const make = (): ColumnarStore => {
      const store = new ColumnarStore({ capacity: 8 });
      store.appendBatch(['b', 'a', 'c'].map((strategyParams, i) => ({ ...(orders[0] as Order), orderId: `R${i}`, strategyParams })));
      return store;
    };

    it('has no state until first asked, then reports staleness after appends', () => {
      const store = make();
      expect(store.stringRankState('strategyParams')).toBeNull();
      expect(store.staleRankFields()).toEqual([]);
      store.stringRank('strategyParams');
      expect(store.stringRankState('strategyParams')?.built).toBe(3);
      store.appendBatch([{ ...(orders[0] as Order), orderId: 'R9', strategyParams: 'A' }]);
      expect(store.stringRankState('strategyParams')?.built).toBe(3);
      expect(store.staleRankFields()).toEqual(['strategyParams']);
    });

    it('refreshes in the background to the same ranks a full rebuild gives', () => {
      const store = make();
      store.stringRank('strategyParams');
      store.appendBatch(['B', 'zz', 'a'].map((strategyParams, i) => ({ ...(orders[0] as Order), orderId: `S${i}`, strategyParams })));
      for (const _ of store.refreshStringRanks('strategyParams', 2)) void _;
      const refreshed = [...(store.stringRankState('strategyParams')?.rank ?? [])];
      expect(store.staleRankFields()).toEqual([]);
      expect(refreshed).toEqual([...store.stringRank('strategyParams')]);
      expect(refreshed).toEqual([2, 1, 3, 0, 4, 1]);
    });

    it('marks ranks dirty when a covered string changes and rebuilds them on refresh', () => {
      const store = make();
      store.stringRank('strategyParams');
      store.updateRow(0, { strategyParams: 'zzz' });
      expect(store.stringRankState('strategyParams')).toBeNull();
      expect(store.staleRankFields()).toEqual(['strategyParams']);
      for (const _ of store.refreshStringRanks('strategyParams')) void _;
      expect([...(store.stringRankState('strategyParams')?.rank ?? [])]).toEqual([2, 0, 1]);
    });

    it('ignores a refresh for a column that was never ranked', () => {
      const store = make();
      expect([...store.refreshStringRanks('clientOrderId')]).toEqual([]);
    });
  });
});
