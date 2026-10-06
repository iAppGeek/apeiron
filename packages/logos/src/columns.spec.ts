import { describe, expect, it } from 'vitest';
import {
  COLUMNS,
  COLUMNS_VERSION,
  COLUMN_BY_FIELD,
  FREE_TEXT_FIELDS,
  GROUPABLE_FIELDS,
  computeColumnsVersion,
} from './columns.js';
import { generateOrders } from './generator.js';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

describe('columns', () => {
  it('defines exactly 50 unique columns matching the Order fields', () => {
    expect(COLUMNS).toHaveLength(50);
    expect(COLUMN_BY_FIELD.size).toBe(50);
    const order = generateOrders(42, 10, NOW).next().value;
    expect(order).toBeDefined();
    expect(COLUMNS.map((c) => c.field).sort()).toEqual(Object.keys(order ?? {}).sort());
  });

  it('keeps the groupable set from Appendix B', () => {
    expect([...GROUPABLE_FIELDS].sort()).toEqual(
      [
        'traderName',
        'account',
        'currencyPair',
        'baseCcy',
        'quoteCcy',
        'tenor',
        'side',
        'algoType',
        'status',
        'orderType',
        'timeInForce',
        'urgency',
        'venue',
        'valueDate',
      ].sort(),
    );
  });

  it('uses the default aggregates from Appendix B', () => {
    const withAgg = (f: string): string[] =>
      COLUMNS.filter((c) => c.aggFunc === f).map((c) => c.field).sort();
    expect(withAgg('sum')).toEqual(
      [
        'orderQty',
        'filledQty',
        'notionalUsd',
        'filledNotionalUsd',
        'slippageUsd',
        'unrealisedPnlUsd',
        'realisedPnlUsd',
        'numFills',
      ].sort(),
    );
    expect(withAgg('wavg:notionalUsd')).toEqual(['slippageBps', 'perfVsVwapBps', 'pctComplete'].sort());
  });

  it('keeps filter kinds consistent with column types', () => {
    for (const c of COLUMNS) {
      if (c.type === 'enum') expect(c.filter).toBe('set');
      if (c.type === 'number') expect(c.filter).toBe('number');
      if (c.type === 'datetime' || c.type === 'date') expect(c.filter).toBe('date');
      if (c.type === 'string') expect(c.filter).toBe('text');
    }
    for (const f of FREE_TEXT_FIELDS) expect(COLUMN_BY_FIELD.get(f)?.filter).toBe('text');
  });

  it('flags price columns for up/down flash', () => {
    expect(COLUMN_BY_FIELD.get('marketMid')?.priceColumn).toBe(true);
    expect(COLUMN_BY_FIELD.get('orderQty')?.priceColumn).toBeUndefined();
  });

  it('produces a stable version fingerprint that changes with the columns', () => {
    expect(COLUMNS_VERSION).toMatch(/^[0-9a-f]{8}$/);
    expect(computeColumnsVersion(COLUMNS)).toBe(COLUMNS_VERSION);
    expect(computeColumnsVersion(COLUMNS.slice(1))).not.toBe(COLUMNS_VERSION);
  });
});
