import type { FilterModel, Order } from '@apeiron/logos';
import { describe, expect, it } from 'vitest';
import { makeStore } from '../testing/orders.js';
import { compileFilter, filterRows } from './filter.js';

const D = (y: number, m: number, d: number, h = 0, mi = 0, s = 0): number => Date.UTC(y, m - 1, d, h, mi, s);

function rowsOf(overrides: Partial<Order>[], model: FilterModel, trader = 'ALL'): number[] {
  const store = makeStore(overrides);
  return [...filterRows(store.size, compileFilter(store, model, trader))];
}

describe('text filters (case-insensitive)', () => {
  const data: Partial<Order>[] = [
    { clientOrderId: 'Alpha' },
    { clientOrderId: 'alphabet' },
    { clientOrderId: 'BETA' },
    { clientOrderId: '' },
    { clientOrderId: 'xALPHA' },
  ];
  const t = (type: string, filter?: string): FilterModel => ({
    clientOrderId: { filterType: 'text', type, filter } as FilterModel[string],
  });

  it('contains', () => expect(rowsOf(data, t('contains', 'ALPH'))).toEqual([0, 1, 4]));
  it('notContains', () => expect(rowsOf(data, t('notContains', 'alph'))).toEqual([2, 3]));
  it('equals', () => expect(rowsOf(data, t('equals', 'ALPHA'))).toEqual([0]));
  it('notEqual', () => expect(rowsOf(data, t('notEqual', 'alpha'))).toEqual([1, 2, 3, 4]));
  it('startsWith', () => expect(rowsOf(data, t('startsWith', 'AL'))).toEqual([0, 1]));
  it('endsWith', () => expect(rowsOf(data, t('endsWith', 'Pha'))).toEqual([0, 4]));
  it('blank matches the empty string', () => expect(rowsOf(data, t('blank'))).toEqual([3]));
  it('notBlank', () => expect(rowsOf(data, t('notBlank'))).toEqual([0, 1, 2, 4]));
  it('an empty needle matches everything for contains', () => {
    expect(rowsOf(data, t('contains', ''))).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('number filters', () => {
  // limitPrice is nullable: null must only ever match blank.
  const data: Partial<Order>[] = [
    { limitPrice: 1 },
    { limitPrice: 2 },
    { limitPrice: null },
    { limitPrice: 3 },
    { limitPrice: -2 },
    { limitPrice: 0 },
  ];
  const n = (type: string, filter?: number, filterTo?: number): FilterModel => ({
    limitPrice: { filterType: 'number', type, filter, filterTo } as FilterModel[string],
  });

  it('equals', () => expect(rowsOf(data, n('equals', 2))).toEqual([1]));
  it('equals matches zero', () => expect(rowsOf(data, n('equals', 0))).toEqual([5]));
  it('notEqual excludes null', () => expect(rowsOf(data, n('notEqual', 2))).toEqual([0, 3, 4, 5]));
  it('lessThan excludes null', () => expect(rowsOf(data, n('lessThan', 2))).toEqual([0, 4, 5]));
  it('lessThanOrEqual', () => expect(rowsOf(data, n('lessThanOrEqual', 2))).toEqual([0, 1, 4, 5]));
  it('greaterThan', () => expect(rowsOf(data, n('greaterThan', 1))).toEqual([1, 3]));
  it('greaterThanOrEqual', () => expect(rowsOf(data, n('greaterThanOrEqual', 1))).toEqual([0, 1, 3]));
  it('inRange is inclusive and excludes null', () => expect(rowsOf(data, n('inRange', 0, 2))).toEqual([0, 1, 5]));
  it('inRange with from after to matches nothing', () => expect(rowsOf(data, n('inRange', 5, 1))).toEqual([]));
  it('blank matches only null', () => expect(rowsOf(data, n('blank'))).toEqual([2]));
  it('notBlank matches only non-null', () => expect(rowsOf(data, n('notBlank'))).toEqual([0, 1, 3, 4, 5]));
});

describe('date filters (epoch ms, UTC)', () => {
  const data: Partial<Order>[] = [
    { completedAt: D(2026, 3, 1, 0, 0, 0) },
    { completedAt: D(2026, 3, 1, 13, 30, 0) },
    { completedAt: D(2026, 3, 1, 23, 59, 59) },
    { completedAt: D(2026, 3, 2, 0, 0, 0) },
    { completedAt: null },
    { completedAt: D(2026, 2, 28, 12, 0, 0) },
  ];
  const d = (type: string, dateFrom?: string, dateTo?: string): FilterModel => ({
    completedAt: { filterType: 'date', type, dateFrom, dateTo } as FilterModel[string],
  });

  it('equals compares at UTC-day granularity', () => {
    expect(rowsOf(data, d('equals', '2026-03-01 09:00:00'))).toEqual([0, 1, 2]);
  });
  it('notEqual is day-granular and excludes null', () => {
    expect(rowsOf(data, d('notEqual', '2026-03-01 00:00:00'))).toEqual([3, 5]);
  });
  it('lessThan compares the exact instant', () => {
    expect(rowsOf(data, d('lessThan', '2026-03-01 13:30:00'))).toEqual([0, 5]);
  });
  it('lessThanOrEqual', () => {
    expect(rowsOf(data, d('lessThanOrEqual', '2026-03-01 13:30:00'))).toEqual([0, 1, 5]);
  });
  it('greaterThan', () => expect(rowsOf(data, d('greaterThan', '2026-03-01 13:30:00'))).toEqual([2, 3]));
  it('greaterThanOrEqual', () => {
    expect(rowsOf(data, d('greaterThanOrEqual', '2026-03-01 13:30:00'))).toEqual([1, 2, 3]);
  });
  it('inRange is inclusive at both ends', () => {
    expect(rowsOf(data, d('inRange', '2026-03-01 00:00:00', '2026-03-01 13:30:00'))).toEqual([0, 1]);
  });
  it('blank / notBlank', () => {
    expect(rowsOf(data, d('blank'))).toEqual([4]);
    expect(rowsOf(data, d('notBlank'))).toEqual([0, 1, 2, 3, 5]);
  });
});

describe('set filters (dictionary codes)', () => {
  const data: Partial<Order>[] = [
    { status: 'LIVE' },
    { status: 'FILLED' },
    { status: 'PAUSED' },
    { status: 'LIVE' },
    { status: 'CANCELLED' },
  ];
  const s = (values: string[]): FilterModel => ({ status: { filterType: 'set', values } });

  it('matches listed values', () => expect(rowsOf(data, s(['LIVE', 'PAUSED']))).toEqual([0, 2, 3]));
  it('ignores values that are not in the dictionary', () => {
    expect(rowsOf(data, s(['LIVE', 'NOPE']))).toEqual([0, 3]);
  });
  it('matches nothing for an empty or unknown selection', () => {
    expect(rowsOf(data, s([]))).toEqual([]);
    expect(rowsOf(data, s(['NOPE']))).toEqual([]);
  });
  it('is case-sensitive', () => expect(rowsOf(data, s(['live']))).toEqual([]));
});

describe('combined conditions', () => {
  const data: Partial<Order>[] = [
    { limitPrice: 1 },
    { limitPrice: 5 },
    { limitPrice: 9 },
    { limitPrice: null },
  ];
  const combo = (operator: 'AND' | 'OR'): FilterModel => ({
    limitPrice: {
      filterType: 'number',
      operator,
      conditions: [
        { filterType: 'number', type: 'greaterThan', filter: 2 },
        { filterType: 'number', type: 'lessThan', filter: 8 },
      ],
    },
  });

  it('AND', () => expect(rowsOf(data, combo('AND'))).toEqual([1]));
  it('OR never matches null for ordinary operators', () => expect(rowsOf(data, combo('OR'))).toEqual([0, 1, 2]));
  it('OR with blank matches null', () => {
    const model: FilterModel = {
      limitPrice: {
        filterType: 'number',
        operator: 'OR',
        conditions: [
          { filterType: 'number', type: 'blank' },
          { filterType: 'number', type: 'equals', filter: 9 },
        ],
      },
    };
    expect(rowsOf(data, model)).toEqual([2, 3]);
  });
  it('combines text conditions', () => {
    const rows: Partial<Order>[] = [{ clientOrderId: 'ab' }, { clientOrderId: 'bc' }, { clientOrderId: 'cd' }];
    const model: FilterModel = {
      clientOrderId: {
        filterType: 'text',
        operator: 'OR',
        conditions: [
          { filterType: 'text', type: 'startsWith', filter: 'a' },
          { filterType: 'text', type: 'endsWith', filter: 'D' },
        ],
      },
    };
    expect(rowsOf(rows, model)).toEqual([0, 2]);
  });
});

describe('multiple columns and trader scope', () => {
  const data: Partial<Order>[] = [
    { traderId: 'T1', status: 'LIVE', limitPrice: 1 },
    { traderId: 'T2', status: 'LIVE', limitPrice: 2 },
    { traderId: 'T1', status: 'FILLED', limitPrice: 3 },
    { traderId: 'T1', status: 'LIVE', limitPrice: 4 },
  ];

  it('ANDs filters across columns', () => {
    const model: FilterModel = {
      status: { filterType: 'set', values: ['LIVE'] },
      limitPrice: { filterType: 'number', type: 'greaterThan', filter: 1 },
    };
    expect(rowsOf(data, model)).toEqual([1, 3]);
  });

  it('applies the trader as an implicit filter', () => {
    expect(rowsOf(data, {}, 'T1')).toEqual([0, 2, 3]);
    expect(rowsOf(data, { status: { filterType: 'set', values: ['LIVE'] } }, 'T1')).toEqual([0, 3]);
  });

  it('an unknown trader matches nothing', () => {
    expect(rowsOf(data, {}, 'T9')).toEqual([]);
  });

  it('no filter and ALL passes every row', () => {
    expect(rowsOf(data, {})).toEqual([0, 1, 2, 3]);
  });

  it('handles three or more predicates', () => {
    const model: FilterModel = {
      status: { filterType: 'set', values: ['LIVE'] },
      limitPrice: { filterType: 'number', type: 'lessThan', filter: 4 },
      clientOrderId: { filterType: 'text', type: 'notBlank' },
    };
    const rows = data.map((d) => ({ ...d, clientOrderId: 'x' }));
    expect(rowsOf(rows, model, 'T1')).toEqual([0]);
  });
});
