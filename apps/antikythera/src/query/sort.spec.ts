import { mulberry32, type Order } from '@apeiron/logos';
import { describe, expect, it } from 'vitest';
import { propertyOrders, storeFrom } from '../testing/dataset.js';
import { makeOrders, makeStore } from '../testing/orders.js';
import { DEFAULT_SORT, sortRows, type SortKey } from './sort.js';

const all = (n: number): Uint32Array => Uint32Array.from({ length: n }, (_, i) => i);
const ids = (rows: Uint32Array): number[] => [...rows];

describe('sortRows', () => {
  it('sorts numbers ascending and descending with the orderId tiebreak in the same direction', () => {
    const store = makeStore([{ orderQty: 5 }, { orderQty: 1 }, { orderQty: 5 }, { orderQty: 3 }, { orderQty: 1 }]);
    expect(ids(sortRows(store, all(5), [{ field: 'orderQty', desc: false }]))).toEqual([1, 4, 3, 0, 2]);
    expect(ids(sortRows(store, all(5), [{ field: 'orderQty', desc: true }]))).toEqual([2, 0, 3, 4, 1]);
  });

  it('puts nulls first ascending and last descending', () => {
    const store = makeStore([{ limitPrice: 2 }, { limitPrice: null }, { limitPrice: -1 }, { limitPrice: null }]);
    expect(ids(sortRows(store, all(4), [{ field: 'limitPrice', desc: false }]))).toEqual([1, 3, 2, 0]);
    expect(ids(sortRows(store, all(4), [{ field: 'limitPrice', desc: true }]))).toEqual([0, 2, 3, 1]);
  });

  it('orders negatives, zero, fractions and large magnitudes correctly', () => {
    const values = [3.5, -0.25, 0, -1e300, 1e300, -7, 1e-300, -1e-300, 42];
    const store = makeStore(values.map((orderQty) => ({ orderQty })));
    const sorted = ids(sortRows(store, all(values.length), [{ field: 'orderQty', desc: false }])).map((i) => values[i]);
    expect(sorted).toEqual([...values].sort((a, b) => (a as number) - (b as number)));
  });

  it('treats -0 and 0 as equal', () => {
    const store = makeStore([{ orderQty: 0 }, { orderQty: -0 }, { orderQty: 0 }]);
    expect(ids(sortRows(store, all(3), [{ field: 'orderQty', desc: false }]))).toEqual([0, 1, 2]);
  });

  it('applies multiple keys in order', () => {
    const store = makeStore([
      { side: 'SELL', orderQty: 1 },
      { side: 'BUY', orderQty: 2 },
      { side: 'BUY', orderQty: 1 },
      { side: 'SELL', orderQty: 2 },
    ]);
    const keys: SortKey[] = [
      { field: 'side', desc: false },
      { field: 'orderQty', desc: true },
    ];
    expect(ids(sortRows(store, all(4), keys))).toEqual([1, 2, 3, 0]);
  });

  it('sorts enums by value rank, not by first-seen code', () => {
    const store = makeStore([{ venue: 'LMAX' }, { venue: 'EBS' }, { venue: 'HOTSPOT' }, { venue: 'EBS' }]);
    expect(ids(sortRows(store, all(4), [{ field: 'venue', desc: false }]))).toEqual([1, 3, 2, 0]);
    expect(ids(sortRows(store, all(4), [{ field: 'venue', desc: true }]))).toEqual([0, 2, 3, 1]);
  });

  it('sorts free-text string columns', () => {
    const store = makeStore([{ strategyParams: 'b' }, { strategyParams: 'a' }, { strategyParams: 'B' }]);
    expect(ids(sortRows(store, all(3), [{ field: 'strategyParams', desc: false }]))).toEqual([2, 1, 0]);
  });

  it('truncates after orderId, which is unique', () => {
    const store = makeStore([{ orderQty: 1 }, { orderQty: 2 }]);
    const keys: SortKey[] = [
      { field: 'orderId', desc: true },
      { field: 'orderQty', desc: false },
    ];
    expect(ids(sortRows(store, all(2), keys))).toEqual([1, 0]);
  });

  it('defaults are createdAt descending with orderId descending on ties', () => {
    const store = makeStore([{ createdAt: 10 }, { createdAt: 30 }, { createdAt: 30 }, { createdAt: 20 }]);
    expect(ids(sortRows(store, all(4), DEFAULT_SORT))).toEqual([2, 1, 3, 0]);
  });

  it('sorts a subset and never mutates the input', () => {
    const store = makeStore([{ orderQty: 4 }, { orderQty: 3 }, { orderQty: 2 }, { orderQty: 1 }]);
    const subset = Uint32Array.from([0, 2, 3]);
    expect(ids(sortRows(store, subset, [{ field: 'orderQty', desc: false }]))).toEqual([3, 2, 0]);
    expect(ids(subset)).toEqual([0, 2, 3]);
  });

  it('handles empty and single-row inputs', () => {
    const store = makeStore([{ orderQty: 1 }]);
    expect(sortRows(store, new Uint32Array(0), DEFAULT_SORT)).toHaveLength(0);
    expect(ids(sortRows(store, all(1), DEFAULT_SORT))).toEqual([0]);
  });

  it('falls back to a comparator when row order is not orderId order', () => {
    const orders: Order[] = makeOrders([{ orderQty: 2 }, { orderQty: 2 }, { orderQty: 1 }]);
    const reordered = [orders[2], orders[1], orders[0]] as Order[];
    const store = storeFrom(reordered);
    expect(store.idsAscending).toBe(false);
    // Ties on orderQty break by orderId ascending: T..2 (row 1) before T..3... rows are [T3, T2, T1].
    expect(ids(sortRows(store, all(3), [{ field: 'orderQty', desc: false }]))).toEqual([0, 2, 1]);
    expect(ids(sortRows(store, all(3), [{ field: 'orderQty', desc: true }]))).toEqual([1, 2, 0]);
  });

  it('matches a naive comparator sort on real generator data for random key sets', () => {
    const orders = propertyOrders(11, 2_500);
    const store = storeFrom(orders);
    const fields = ['orderQty', 'limitPrice', 'status', 'currencyPair', 'createdAt', 'slippageBps', 'numFills', 'venue', 'completedAt', 'clientOrderId'] as const;
    const rng = mulberry32(5);
    for (let t = 0; t < 60; t++) {
      const keys: SortKey[] = [];
      const count = 1 + Math.floor(rng() * 3);
      for (let k = 0; k < count; k++) keys.push({ field: fields[Math.floor(rng() * fields.length)] as SortKey['field'], desc: rng() < 0.5 });
      const rows = Uint32Array.from(orders.map((_, i) => i).filter(() => rng() < 0.8));
      const cmp = (a: number, b: number): number => {
        for (const k of keys) {
          const x = (orders[a] as Order)[k.field] as number | string | null;
          const y = (orders[b] as Order)[k.field] as number | string | null;
          if (x === y) continue;
          const r = x === null ? -1 : y === null ? 1 : x < y ? -1 : 1;
          return k.desc ? -r : r;
        }
        const last = (keys[keys.length - 1] as SortKey).desc ? -1 : 1;
        return a < b ? -last : last;
      };
      const expected = [...rows].sort(cmp);
      expect(ids(sortRows(store, rows, keys)), JSON.stringify(keys)).toEqual(expected);
    }
  });
});
