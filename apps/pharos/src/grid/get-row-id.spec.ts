import type { GetRowIdParams } from 'ag-grid-community';
import { describe, expect, it } from 'vitest';
import { computeRowId, getRowId } from './get-row-id';

describe('computeRowId', () => {
  it('uses orderId for leaf rows', () => {
    expect(computeRowId({ data: { orderId: 'ALG00000042', currencyPair: 'EURUSD' }, level: 1, groupFields: ['currencyPair'] })).toBe('ALG00000042');
  });

  it('builds G:key for a top-level group row', () => {
    expect(computeRowId({ data: { currencyPair: 'EURUSD', childCount: 10 }, parentKeys: [], level: 0, groupFields: ['currencyPair', 'side'] })).toBe('G:EURUSD');
  });

  it('joins parent keys with | for nested group rows', () => {
    expect(
      computeRowId({
        data: { side: 'BUY', childCount: 3 },
        parentKeys: ['EURUSD'],
        level: 1,
        groupFields: ['currencyPair', 'side'],
      }),
    ).toBe('G:EURUSD|BUY');
  });

  it('keeps the (blank) key and date keys as given', () => {
    expect(computeRowId({ data: { tenor: '(blank)' }, parentKeys: undefined, level: 0, groupFields: ['tenor'] })).toBe('G:(blank)');
    expect(computeRowId({ data: { valueDate: '2026-04-09' }, parentKeys: [], level: 0, groupFields: ['valueDate'] })).toBe('G:2026-04-09');
  });
});

describe('getRowId', () => {
  const makeParams = (data: unknown, level: number, parentKeys: string[] | undefined, fields: string[]): GetRowIdParams =>
    ({
      data,
      level,
      parentKeys,
      api: { getRowGroupColumns: () => fields.map((f) => ({ getColDef: () => ({ field: f }) })) },
    }) as unknown as GetRowIdParams;

  it('reads the active row-group columns from the api', () => {
    expect(getRowId(makeParams({ orderId: 'ALG1' }, 2, ['EURUSD', 'BUY'], ['currencyPair', 'side']))).toBe('ALG1');
    expect(getRowId(makeParams({ side: 'SELL' }, 1, ['GBPUSD'], ['currencyPair', 'side']))).toBe('G:GBPUSD|SELL');
    expect(getRowId(makeParams({ currencyPair: 'USDJPY' }, 0, [], ['currencyPair']))).toBe('G:USDJPY');
  });
});
