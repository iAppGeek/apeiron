import { describe, expect, it } from 'vitest';
import {
  NUMBER_FILTER_TYPES,
  TEXT_FILTER_TYPES,
  UNSUPPORTED_FILTER,
  parseFilterDate,
  parseFilterModel,
} from './filter-model.js';

const bad = (input: unknown): string => {
  const r = parseFilterModel(input);
  if (r.ok) throw new Error('expected failure');
  expect(r.code).toBe(UNSUPPORTED_FILTER);
  return r.error;
};

describe('parseFilterModel', () => {
  it('treats null and undefined as an empty model', () => {
    expect(parseFilterModel(null)).toEqual({ ok: true, value: {} });
    expect(parseFilterModel(undefined)).toEqual({ ok: true, value: {} });
  });

  it.each(TEXT_FILTER_TYPES)('accepts text operator %s', (type) => {
    const blank = type === 'blank' || type === 'notBlank';
    const r = parseFilterModel({ a: blank ? { filterType: 'text', type } : { filterType: 'text', type, filter: 'x' } });
    expect(r.ok).toBe(true);
  });

  it.each(NUMBER_FILTER_TYPES)('accepts number and date operator %s', (type) => {
    const blank = type === 'blank' || type === 'notBlank';
    const n = blank
      ? { filterType: 'number', type }
      : { filterType: 'number', type, filter: 1, filterTo: type === 'inRange' ? 5 : undefined };
    const d = blank
      ? { filterType: 'date', type }
      : {
          filterType: 'date',
          type,
          dateFrom: '2026-01-02 00:00:00',
          dateTo: type === 'inRange' ? '2026-01-03 00:00:00' : null,
        };
    expect(parseFilterModel({ n, d }).ok).toBe(true);
  });

  it('accepts set and combined filters', () => {
    const r = parseFilterModel({
      status: { filterType: 'set', values: ['LIVE', 'PAUSED'] },
      qty: {
        filterType: 'number',
        operator: 'OR',
        conditions: [
          { filterType: 'number', type: 'lessThan', filter: 1 },
          { filterType: 'number', type: 'greaterThan', filter: 9 },
        ],
      },
      name: {
        filterType: 'text',
        operator: 'AND',
        conditions: [{ filterType: 'text', type: 'contains', filter: 'a' }],
      },
    });
    expect(r.ok).toBe(true);
  });

  it('rejects unknown shapes with UNSUPPORTED_FILTER', () => {
    bad('nope');
    bad({ a: 'nope' });
    bad({ a: { filterType: 'multi', filterModels: [] } });
    bad({ a: { filterType: 'text', type: 'regex', filter: 'x' } });
    bad({ a: { filterType: 'text', type: 'contains' } });
    bad({ a: { filterType: 'number', type: 'equals' } });
    bad({ a: { filterType: 'number', type: 'inRange', filter: 1 } });
    bad({ a: { filterType: 'number', type: 'equals', filter: Number.POSITIVE_INFINITY } });
    bad({ a: { filterType: 'date', type: 'equals', dateFrom: 'yesterday' } });
    bad({ a: { filterType: 'date', type: 'inRange', dateFrom: '2026-01-01 00:00:00' } });
    bad({ a: { filterType: 'set', values: [1] } });
    bad({ a: { filterType: 'number', operator: 'XOR', conditions: [] } });
    bad({ a: { filterType: 'number', operator: 'AND', conditions: [] } });
    bad({
      a: { filterType: 'number', operator: 'AND', conditions: [{ filterType: 'text', type: 'contains', filter: 'x' }] },
    });
  });

  it('reports a path in the error', () => {
    expect(bad({ a: { filterType: 'number', type: 'equals' } })).toContain('a');
  });
});

describe('parseFilterDate', () => {
  it('parses UTC timestamps', () => {
    expect(parseFilterDate('2026-10-06 12:30:15')).toBe(Date.UTC(2026, 9, 6, 12, 30, 15));
    expect(parseFilterDate('2026-10-06')).toBe(Date.UTC(2026, 9, 6));
    expect(parseFilterDate('2026-10-06T01:02:03')).toBe(Date.UTC(2026, 9, 6, 1, 2, 3));
  });

  it('rejects malformed and out-of-range dates', () => {
    for (const s of ['', 'x', '2026-13-01', '2026-02-31', '2026-01-01 24:00:00', '2026-1-1']) {
      expect(parseFilterDate(s)).toBeNaN();
    }
  });
});
