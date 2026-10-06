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

  it('bumps its version on append and ignores empty batches', () => {
    const store = new ColumnarStore({ capacity: 4 });
    const v0 = store.version;
    store.appendBatch([]);
    expect(store.version).toBe(v0);
    store.appendBatch([orders[0] as Order]);
    expect(store.version).toBe(v0 + 1);
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
});
