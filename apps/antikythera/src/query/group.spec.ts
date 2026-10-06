import type { Order } from '@apeiron/logos';
import { describe, expect, it } from 'vitest';
import { makeStore } from '../testing/orders.js';
import { BLANK_KEY, buildGroupLevel, dayKey, type GroupSortSpec } from './group.js';
import type { ValueCol } from './request.js';

const all = (n: number): Uint32Array => Uint32Array.from({ length: n }, (_, i) => i);
const vc = (field: ValueCol['field'], agg: ValueCol['agg']): ValueCol => ({ id: field, field, agg });
const D = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d);

const data: Partial<Order>[] = [
  { side: 'SELL', slippageBps: 2, notionalUsd: 100, orderQty: 10, completedAt: null },
  { side: 'BUY', slippageBps: 4, notionalUsd: 300, orderQty: 20, completedAt: null },
  { side: 'SELL', slippageBps: null, notionalUsd: 900, orderQty: 30, completedAt: null },
  { side: 'SELL', slippageBps: 6, notionalUsd: 300, orderQty: 40, completedAt: null },
  { side: 'BUY', slippageBps: null, notionalUsd: 50, orderQty: 5, completedAt: null },
];

describe('buildGroupLevel', () => {
  it('groups by an enum, ordering keys ascending by default', () => {
    const level = buildGroupLevel(makeStore(data), all(5), 'side', [], []);
    expect(level.labels).toEqual(['BUY', 'SELL']);
    expect([...level.counts]).toEqual([2, 3]);
    expect([...level.offsets]).toEqual([0, 2, 5]);
    expect([...level.part]).toEqual([1, 4, 0, 2, 3]);
    expect(level.indexByLabel.get('SELL')).toBe(1);
  });

  it('computes sum, avg, count and wavg, skipping nulls (and their weight)', () => {
    const level = buildGroupLevel(
      makeStore(data),
      all(5),
      'side',
      [vc('orderQty', 'sum'), vc('slippageBps', 'avg'), vc('slippageBps', 'count'), vc('slippageBps', 'wavg')],
      [],
    );
    expect(level.aggs[0]).toEqual([25, 80]);
    expect(level.aggs[1]).toEqual([4, 4]); // BUY has one non-null (4); SELL has 2 and 6
    expect(level.aggs[2]).toEqual([1, 2]);
    // SELL wavg weights 100 and 300 only (the 900 row is null): (2*100 + 6*300) / 400 = 5
    expect(level.aggs[3]).toEqual([4, 5]);
  });

  it('gives null when every value is null, for every aggregate', () => {
    const level = buildGroupLevel(
      makeStore(data),
      all(5),
      'side',
      [vc('completedAt', 'count'), vc('completedAt', 'avg'), vc('completedAt', 'sum'), vc('completedAt', 'wavg')],
      [],
    );
    for (const a of level.aggs) expect(a).toEqual([null, null]);
  });

  it('counts non-numeric columns', () => {
    const level = buildGroupLevel(makeStore(data), all(5), 'side', [vc('venue', 'count')], []);
    expect(level.aggs[0]).toEqual([2, 3]);
  });

  it('orders groups by key descending, by aggregate, and by aggregate with key tiebreak', () => {
    const store = makeStore(data);
    const sums = [vc('orderQty', 'sum')];
    const keyDesc: GroupSortSpec[] = [{ kind: 'key', desc: true }];
    expect(buildGroupLevel(store, all(5), 'side', sums, keyDesc).labels).toEqual(['SELL', 'BUY']);
    const aggAsc: GroupSortSpec[] = [{ kind: 'agg', index: 0, desc: false }];
    expect(buildGroupLevel(store, all(5), 'side', sums, aggAsc).labels).toEqual(['BUY', 'SELL']);
    const aggDesc: GroupSortSpec[] = [{ kind: 'agg', index: 0, desc: true }];
    expect(buildGroupLevel(store, all(5), 'side', sums, aggDesc).labels).toEqual(['SELL', 'BUY']);
    // Equal aggregates fall back to the key, in the direction of the last sort entry.
    const tie = makeStore([{ side: 'SELL', orderQty: 1 }, { side: 'BUY', orderQty: 1 }]);
    expect(buildGroupLevel(tie, all(2), 'side', sums, aggAsc).labels).toEqual(['BUY', 'SELL']);
    expect(buildGroupLevel(tie, all(2), 'side', sums, aggDesc).labels).toEqual(['SELL', 'BUY']);
  });

  it('sorts null aggregates as the smallest value', () => {
    const store = makeStore([
      { side: 'BUY', completedAt: null },
      { side: 'SELL', completedAt: 5 },
    ]);
    const avg = [vc('completedAt', 'avg')];
    expect(buildGroupLevel(store, all(2), 'side', avg, [{ kind: 'agg', index: 0, desc: false }]).labels).toEqual(['BUY', 'SELL']);
    expect(buildGroupLevel(store, all(2), 'side', avg, [{ kind: 'agg', index: 0, desc: true }]).labels).toEqual(['SELL', 'BUY']);
  });

  it('groups only the rows it is given', () => {
    const level = buildGroupLevel(makeStore(data), Uint32Array.from([0, 2, 4]), 'side', [vc('orderQty', 'sum')], []);
    expect(level.labels).toEqual(['BUY', 'SELL']);
    expect([...level.counts]).toEqual([1, 2]);
    expect(level.aggs[0]).toEqual([5, 40]);
    expect([...level.part]).toEqual([4, 0, 2]);
  });

  it('groups value dates by UTC day, with (blank) for null, which sorts first', () => {
    const store = makeStore([
      { valueDate: D(2026, 3, 3) },
      { valueDate: D(2026, 3, 1) },
      { valueDate: null as unknown as number },
      { valueDate: D(2026, 3, 1) },
      { valueDate: D(2026, 12, 31) },
    ]);
    const level = buildGroupLevel(store, all(5), 'valueDate', [], []);
    expect(level.labels).toEqual([BLANK_KEY, '2026-03-01', '2026-03-03', '2026-12-31']);
    expect([...level.counts]).toEqual([1, 2, 1, 1]);
    const desc = buildGroupLevel(store, all(5), 'valueDate', [], [{ kind: 'key', desc: true }]);
    expect(desc.labels).toEqual(['2026-12-31', '2026-03-03', '2026-03-01', BLANK_KEY]);
  });

  it('formats day keys', () => {
    expect(dayKey(Math.floor(D(2026, 10, 6) / 86_400_000))).toBe('2026-10-06');
  });

  it('handles an empty row set', () => {
    const level = buildGroupLevel(makeStore(data), new Uint32Array(0), 'side', [vc('orderQty', 'sum')], []);
    expect(level.labels).toEqual([]);
    expect([...level.offsets]).toEqual([0]);
  });

  it('refuses columns that cannot be grouped', () => {
    expect(() => buildGroupLevel(makeStore(data), all(5), 'orderQty', [], [])).toThrow(/cannot be grouped/);
  });
});
