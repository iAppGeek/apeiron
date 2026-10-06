import type { Order, SsrmRequest } from '@apeiron/logos';
import { describe, expect, it } from 'vitest';
import { makeOrders } from './orders.js';
import { referenceGetRows, zeroNormalised } from './reference.js';

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

const orders: Order[] = makeOrders([
  { traderId: 'T1', side: 'BUY', orderQty: 1, limitPrice: null, createdAt: 3, clientOrderId: 'Abc' },
  { traderId: 'T2', side: 'SELL', orderQty: 2, limitPrice: 5, createdAt: 2, clientOrderId: 'abd' },
  { traderId: 'T1', side: 'BUY', orderQty: 3, limitPrice: 7, createdAt: 1, clientOrderId: '' },
]);

describe('referenceGetRows', () => {
  it('scopes, filters, sorts and pages leaves with the orderId tiebreak', () => {
    const r = referenceGetRows(orders, 'T1', req({ sortModel: [{ colId: 'side', sort: 'desc' }] }));
    expect(r.rowCount).toBe(2);
    expect(r.rows.map((x) => x.orderId)).toEqual(['T0000003', 'T0000001']);
    expect(referenceGetRows(orders, 'ALL', req()).rows.map((x) => x.createdAt)).toEqual([3, 2, 1]);
    expect(referenceGetRows(orders, 'ALL', req({ startRow: 1, endRow: 2 })).rows).toHaveLength(1);
  });

  it('applies text, number and set filters with null semantics', () => {
    const f = (filterModel: Record<string, unknown>): number => referenceGetRows(orders, 'ALL', req({ filterModel })).rowCount;
    expect(f({ clientOrderId: { filterType: 'text', type: 'startsWith', filter: 'AB' } })).toBe(2);
    expect(f({ clientOrderId: { filterType: 'text', type: 'blank' } })).toBe(1);
    expect(f({ limitPrice: { filterType: 'number', type: 'notEqual', filter: 5 } })).toBe(1);
    expect(f({ limitPrice: { filterType: 'number', type: 'blank' } })).toBe(1);
    expect(f({ side: { filterType: 'set', values: ['SELL'] } })).toBe(1);
    expect(f({ createdAt: { filterType: 'date', type: 'equals', dateFrom: '1970-01-01 10:00:00' } })).toBe(3);
  });

  it('groups with aggregates and nulls', () => {
    const r = referenceGetRows(
      orders,
      'ALL',
      req({
        rowGroupCols: [{ id: 'side' }],
        valueCols: [
          { id: 'limitPrice', aggFunc: 'avg' },
          { id: 'orderQty', aggFunc: 'sum' },
        ],
      }),
    );
    expect(r.rows).toEqual([
      { side: 'BUY', childCount: 2, limitPrice: 7, orderQty: 4 },
      { side: 'SELL', childCount: 1, limitPrice: 5, orderQty: 2 },
    ]);
  });

  it('normalises negative zero', () => {
    expect(Object.is(zeroNormalised({ a: -0 }).a, 0)).toBe(true);
  });
});
