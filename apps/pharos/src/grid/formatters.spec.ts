import { COLUMN_BY_FIELD, PAIR_BY_NAME, type OrderField } from '@apeiron/logos';
import { describe, expect, it } from 'vitest';
import {
  FALLBACK_PRICE_DECIMALS,
  decimalsForRow,
  formatCell,
  formatCount,
  formatDate,
  formatDateTime,
  formatNumber,
} from './formatters';

const meta = (field: OrderField): NonNullable<ReturnType<typeof COLUMN_BY_FIELD.get>> => {
  const m = COLUMN_BY_FIELD.get(field);
  if (m === undefined) throw new Error(`no column ${field}`);
  return m;
};

describe('formatNumber', () => {
  it('uses fixed decimals and thousands separators', () => {
    expect(formatNumber(1234567.891, 2)).toBe('1,234,567.89');
    expect(formatNumber(5, 0)).toBe('5');
    expect(formatNumber(0.5, 3)).toBe('0.500');
  });

  it('shows null, undefined, empty and NaN as empty', () => {
    expect(formatNumber(null, 2)).toBe('');
    expect(formatNumber(undefined, 2)).toBe('');
    expect(formatNumber('', 2)).toBe('');
    expect(formatNumber(Number.NaN, 2)).toBe('');
  });

  it('accepts numeric strings and rejects junk', () => {
    expect(formatNumber('12.5', 1)).toBe('12.5');
    expect(formatNumber('abc', 1)).toBe('');
  });
});

describe('formatDateTime', () => {
  it('formats UTC time as YYYY-MM-DD HH:mm:ss, whatever the local zone', () => {
    expect(formatDateTime(Date.UTC(2026, 2, 5, 7, 8, 9))).toBe('2026-03-05 07:08:09');
    expect(formatDateTime(Date.UTC(2026, 11, 31, 23, 59, 59))).toBe('2026-12-31 23:59:59');
  });

  it('shows non-numbers as empty', () => {
    expect(formatDateTime(null)).toBe('');
    expect(formatDateTime(Number.NaN)).toBe('');
  });
});

describe('formatDate', () => {
  it('formats the UTC calendar day', () => {
    expect(formatDate(Date.UTC(2026, 0, 31))).toBe('2026-01-31');
  });

  it('passes group-key strings through and blanks null', () => {
    expect(formatDate('2026-04-09')).toBe('2026-04-09');
    expect(formatDate('(blank)')).toBe('(blank)');
    expect(formatDate(null)).toBe('');
  });
});

describe('decimalsForRow', () => {
  it('uses the pair decimals of the row', () => {
    expect(decimalsForRow({ currencyPair: 'USDJPY' })).toBe(PAIR_BY_NAME.get('USDJPY')?.decimals);
    expect(decimalsForRow({ currencyPair: 'USDJPY' })).toBe(3);
    expect(decimalsForRow({ currencyPair: 'USDSEK' })).toBe(4);
    expect(decimalsForRow({ currencyPair: 'EURUSD' })).toBe(5);
  });

  it('falls back to 5 on rows without a known pair (group rows)', () => {
    expect(decimalsForRow({})).toBe(FALLBACK_PRICE_DECIMALS);
    expect(decimalsForRow(undefined)).toBe(5);
    expect(decimalsForRow({ currencyPair: 'XXXYYY' })).toBe(5);
  });
});

describe('formatCell', () => {
  it('formats price columns with the row pair decimals', () => {
    expect(formatCell(meta('limitPrice'), 150.1234567, { currencyPair: 'USDJPY' })).toBe('150.123');
    expect(formatCell(meta('arrivalPrice'), 1.0812345, { currencyPair: 'EURUSD' })).toBe('1.08123');
    expect(formatCell(meta('marketMid'), 10.51234, { currencyPair: 'USDSEK' })).toBe('10.5123');
    expect(formatCell(meta('marketMid'), 1.5, undefined)).toBe('1.50000');
  });

  it('shows null on nullable columns as empty', () => {
    expect(formatCell(meta('limitPrice'), null, { currencyPair: 'EURUSD' })).toBe('');
    expect(formatCell(meta('slippageBps'), null, {})).toBe('');
    expect(formatCell(meta('completedAt'), null, {})).toBe('');
  });

  it('uses the column decimals for plain numbers', () => {
    expect(formatCell(meta('orderQty'), 1500000, {})).toBe('1,500,000');
    expect(formatCell(meta('notionalUsd'), 1234.5, {})).toBe('1,234.50');
    expect(formatCell(meta('participationRate'), 12.34, {})).toBe('12.3');
  });

  it('formats datetimes and dates', () => {
    const t = Date.UTC(2026, 5, 1, 13, 14, 15);
    expect(formatCell(meta('createdAt'), t, {})).toBe('2026-06-01 13:14:15');
    expect(formatCell(meta('valueDate'), Date.UTC(2026, 5, 3), {})).toBe('2026-06-03');
  });

  it('prints strings and enums and blanks null', () => {
    expect(formatCell(meta('status'), 'LIVE', {})).toBe('LIVE');
    expect(formatCell(meta('orderId'), null, {})).toBe('');
  });
});

describe('formatCount', () => {
  it('adds thousands separators and blanks non-numbers', () => {
    expect(formatCount(250546)).toBe('250,546');
    expect(formatCount(12)).toBe('12');
    expect(formatCount(undefined)).toBe('');
  });
});
