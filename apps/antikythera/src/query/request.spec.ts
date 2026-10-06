import type { SsrmRequest } from '@apeiron/logos';
import { describe, expect, it } from 'vitest';
import { normalizeRequest, type NormalizedQuery } from './request.js';

const base: SsrmRequest = {
  startRow: 0,
  endRow: 100,
  rowGroupCols: [],
  valueCols: [],
  groupKeys: [],
  sortModel: [],
  filterModel: null,
};
const limits = { maxBlockRows: 1_000 };

function good(req: Partial<SsrmRequest>, trader = 'ALL'): NormalizedQuery {
  const r = normalizeRequest(trader, { ...base, ...req }, limits);
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.value;
}
function code(req: Partial<SsrmRequest>): string {
  const r = normalizeRequest('ALL', { ...base, ...req }, limits);
  if (r.ok) throw new Error('expected failure');
  return r.code;
}

describe('normalizeRequest validation', () => {
  it('rejects pivot mode', () => expect(code({ pivotMode: true })).toBe('UNSUPPORTED_PIVOT'));

  it('rejects unsupported aggregate names', () => {
    for (const aggFunc of ['min', 'max', 'first', 'wavg:notionalUsd', 'AVG']) {
      expect(code({ valueCols: [{ id: 'orderQty', aggFunc }] })).toBe('UNSUPPORTED_AGG');
    }
  });

  it('accepts every supported aggregate name', () => {
    for (const aggFunc of ['sum', 'avg', 'count', 'wavg']) {
      expect(good({ valueCols: [{ id: 'orderQty', aggFunc }] }).valueCols[0]?.agg).toBe(aggFunc);
    }
  });

  it('rejects numeric aggregates on non-numeric columns but allows count', () => {
    expect(code({ valueCols: [{ id: 'venue', aggFunc: 'sum' }] })).toBe('UNSUPPORTED_AGG');
    expect(code({ valueCols: [{ id: 'createdAt', aggFunc: 'avg' }] })).toBe('UNSUPPORTED_AGG');
    expect(good({ valueCols: [{ id: 'venue', aggFunc: 'count' }] }).valueCols).toHaveLength(1);
  });

  it('falls back to the column default aggregate and rejects when there is none', () => {
    expect(good({ valueCols: [{ id: 'slippageBps' }] }).valueCols[0]?.agg).toBe('wavg');
    expect(good({ valueCols: [{ id: 'orderQty' }] }).valueCols[0]?.agg).toBe('sum');
    expect(code({ valueCols: [{ id: 'remainingQty' }] })).toBe('UNSUPPORTED_AGG');
  });

  it('rejects unknown value, group and sort columns', () => {
    expect(code({ valueCols: [{ id: 'nope', aggFunc: 'sum' }] })).toBe('UNKNOWN_COLUMN');
    expect(code({ rowGroupCols: [{ id: 'nope' }] })).toBe('UNKNOWN_COLUMN');
    expect(code({ sortModel: [{ colId: 'nope', sort: 'asc' }] })).toBe('UNKNOWN_COLUMN');
  });

  it('rejects non-groupable and duplicate group columns, and too many keys', () => {
    expect(code({ rowGroupCols: [{ id: 'orderQty' }] })).toBe('UNSUPPORTED_GROUP');
    expect(code({ rowGroupCols: [{ id: 'side' }, { id: 'side' }] })).toBe('BAD_REQUEST');
    expect(code({ rowGroupCols: [{ id: 'side' }], groupKeys: ['BUY', 'x'] })).toBe('BAD_REQUEST');
  });

  it('rejects conflicting aggregates on one column', () => {
    const valueCols = [
      { id: 'orderQty', aggFunc: 'sum' },
      { id: 'orderQty', aggFunc: 'avg' },
    ];
    expect(code({ valueCols })).toBe('BAD_REQUEST');
  });

  it('rejects bad block ranges', () => {
    expect(code({ startRow: 10, endRow: 5 })).toBe('BAD_REQUEST');
    expect(code({ startRow: 0, endRow: 1_001 })).toBe('BAD_REQUEST');
  });

  it('rejects unsupported filter shapes, unknown columns and mismatched kinds', () => {
    expect(code({ filterModel: { orderQty: { filterType: 'multi' } } })).toBe('UNSUPPORTED_FILTER');
    expect(code({ filterModel: { nope: { filterType: 'text', type: 'blank' } } })).toBe('UNSUPPORTED_FILTER');
    expect(code({ filterModel: { orderQty: { filterType: 'text', type: 'contains', filter: 'x' } } })).toBe('UNSUPPORTED_FILTER');
    expect(code({ filterModel: { status: { filterType: 'text', type: 'blank' } } })).toBe('UNSUPPORTED_FILTER');
    expect(code({ filterModel: { createdAt: { filterType: 'number', type: 'blank' } } })).toBe('UNSUPPORTED_FILTER');
  });
});

describe('normalizeRequest normalisation', () => {
  it('defaults an empty flat sort to createdAt desc and shares the key with the explicit form', () => {
    const a = good({});
    const b = good({ sortModel: [{ colId: 'createdAt', sort: 'desc' }] });
    expect(a.sort).toEqual([{ colId: 'createdAt', field: 'createdAt', desc: true }]);
    expect(a.viewKey).toBe(b.viewKey);
  });

  it('keeps an empty sort empty for grouped views', () => {
    expect(good({ rowGroupCols: [{ id: 'side' }] }).sort).toEqual([]);
  });

  it('ignores key order inside filter models', () => {
    const f1 = { orderQty: { filterType: 'number', type: 'inRange', filter: 1, filterTo: 5 } };
    const f2 = { orderQty: { filterTo: 5, type: 'inRange', filterType: 'number', filter: 1 } };
    expect(good({ filterModel: f1 }).viewKey).toBe(good({ filterModel: f2 }).viewKey);
  });

  it('ignores column order in the filter model and set value order', () => {
    const f1 = {
      status: { filterType: 'set', values: ['LIVE', 'FILLED', 'LIVE'] },
      side: { filterType: 'set', values: ['BUY'] },
    };
    const f2 = {
      side: { filterType: 'set', values: ['BUY'] },
      status: { filterType: 'set', values: ['FILLED', 'LIVE'] },
    };
    expect(good({ filterModel: f1 }).viewKey).toBe(good({ filterModel: f2 }).viewKey);
  });

  it('ignores condition order and null placeholders', () => {
    const c1 = { filterType: 'number', type: 'lessThan', filter: 1 };
    const c2 = { filterType: 'number', type: 'greaterThan', filter: 9, filterTo: null };
    const m1 = { orderQty: { filterType: 'number', operator: 'OR', conditions: [c1, c2] } };
    const m2 = { orderQty: { operator: 'OR', filterType: 'number', conditions: [{ filter: 9, type: 'greaterThan', filterType: 'number' }, c1] } };
    expect(good({ filterModel: m1 }).viewKey).toBe(good({ filterModel: m2 }).viewKey);
  });

  it('ignores value column order, and value columns entirely for flat views', () => {
    const v1 = [{ id: 'orderQty', aggFunc: 'sum' }, { id: 'filledQty', aggFunc: 'avg' }];
    const v2 = [...v1].reverse();
    const grouped = { rowGroupCols: [{ id: 'side' }] };
    expect(good({ ...grouped, valueCols: v1 }).viewKey).toBe(good({ ...grouped, valueCols: v2 }).viewKey);
    expect(good({ valueCols: v1 }).viewKey).toBe(good({}).viewKey);
    expect(good({ ...grouped, valueCols: v1 }).viewKey).not.toBe(good({ ...grouped }).viewKey);
  });

  it('distinguishes trader, sort order, sort direction and group columns', () => {
    const keys = new Set([
      good({}).viewKey,
      good({}, 'T1').viewKey,
      good({ sortModel: [{ colId: 'orderQty', sort: 'asc' }] }).viewKey,
      good({ sortModel: [{ colId: 'orderQty', sort: 'desc' }] }).viewKey,
      good({ sortModel: [{ colId: 'orderQty', sort: 'asc' }, { colId: 'side', sort: 'asc' }] }).viewKey,
      good({ sortModel: [{ colId: 'side', sort: 'asc' }, { colId: 'orderQty', sort: 'asc' }] }).viewKey,
      good({ rowGroupCols: [{ id: 'side' }] }).viewKey,
      good({ rowGroupCols: [{ id: 'side' }, { id: 'venue' }] }).viewKey,
      good({ rowGroupCols: [{ id: 'venue' }, { id: 'side' }] }).viewKey,
    ]);
    expect(keys.size).toBe(9);
  });

  it('shares a view across block ranges and group keys', () => {
    const grouped = { rowGroupCols: [{ id: 'side' }, { id: 'venue' }] };
    expect(good({ ...grouped, startRow: 0, endRow: 100 }).viewKey).toBe(
      good({ ...grouped, startRow: 300, endRow: 400, groupKeys: ['BUY'] }).viewKey,
    );
  });

  it('drops the auto group column from flat sorts and repeated sort columns', () => {
    const q = good({
      sortModel: [
        { colId: 'ag-Grid-AutoColumn', sort: 'asc' },
        { colId: 'orderQty', sort: 'desc' },
        { colId: 'orderQty', sort: 'asc' },
      ],
    });
    expect(q.sort).toEqual([{ colId: 'orderQty', field: 'orderQty', desc: true }]);
  });

  it('resolves group and value columns by field, falling back to id', () => {
    const q = good({
      rowGroupCols: [{ id: 'ag-1', field: 'side' }, { id: 'venue' }],
      valueCols: [{ id: 'c1', field: 'orderQty', aggFunc: 'sum' }],
    });
    expect(q.groupCols).toEqual(['side', 'venue']);
    expect(q.valueCols).toEqual([{ id: 'c1', field: 'orderQty', agg: 'sum' }]);
  });
});
