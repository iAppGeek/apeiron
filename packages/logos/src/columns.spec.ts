import { describe, expect, it } from 'vitest';
import {
  COLUMNS,
  COLUMNS_VERSION,
  COLUMN_BY_FIELD,
  FREE_TEXT_FIELDS,
  GROUPABLE_FIELDS,
  computeColumnsVersion,
  priceDecimals,
} from './columns.js';
import { generateOrders } from './generator.js';
import type { Order, OrderField } from './order.js';

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

  it('marks nullable columns exactly as the number | null fields of Order', () => {
    // Compile-time: this record must list every Order field, so adding a field forces a decision here.
    const nullable: Record<OrderField, boolean> = {
      orderId: false, parentOrderId: false, clientOrderId: false, traderId: false, traderName: false, account: false,
      currencyPair: false, baseCcy: false, quoteCcy: false, tenor: false, valueDate: false,
      side: false, algoType: false, status: false, orderType: false, timeInForce: false, urgency: false, venue: false,
      strategyParams: false,
      orderQty: false, filledQty: false, remainingQty: false, pctComplete: false, notionalUsd: false, filledNotionalUsd: false,
      limitPrice: true, arrivalPrice: false, avgFillPrice: true, marketBid: false, marketAsk: false, marketMid: false,
      lastFillPrice: true, distanceToLimitBps: true, spreadBps: false,
      slippageBps: true, slippageUsd: false, unrealisedPnlUsd: false, realisedPnlUsd: false, vwapBenchmark: true,
      perfVsVwapBps: true,
      numFills: false, numChildOrders: false, participationRate: false, lastFillQty: false,
      createdAt: false, startTime: false, endTime: false, lastUpdateTime: false, completedAt: true, durationMins: false,
    };
    const expected = (Object.keys(nullable) as OrderField[]).filter((f) => nullable[f]).sort();
    expect(COLUMNS.filter((c) => c.nullable === true).map((c) => c.field).sort()).toEqual(expected);

    // Fixture-driven: a field is observed as null in generated data only if it is flagged nullable.
    const seenNull = new Set<string>();
    for (const o of generateOrders(42, 100_000, NOW)) {
      for (const [k, v] of Object.entries(o as Order)) if (v === null) seenNull.add(k);
    }
    expect([...seenNull].sort()).toEqual(expected);
  });

  it('flags pairDecimals on exactly the price columns, without fixed decimals', () => {
    const price = COLUMNS.filter((c) => c.priceColumn === true).map((c) => c.field).sort();
    expect(COLUMNS.filter((c) => c.pairDecimals === true).map((c) => c.field).sort()).toEqual(price);
    expect(price).toEqual(
      ['limitPrice', 'arrivalPrice', 'avgFillPrice', 'marketBid', 'marketAsk', 'marketMid', 'lastFillPrice', 'vwapBenchmark'].sort(),
    );
    for (const c of COLUMNS.filter((x) => x.pairDecimals === true)) expect(c.decimals).toBeUndefined();
  });

  it('priceDecimals follows the pair table', () => {
    expect(priceDecimals('EURUSD')).toBe(5);
    expect(priceDecimals('USDJPY')).toBe(3);
    expect(priceDecimals('USDTRY')).toBe(4);
    expect(() => priceDecimals('XXXYYY' as never)).toThrow(/Unknown/);
  });

  it('produces a stable version fingerprint that changes with the columns', () => {
    expect(COLUMNS_VERSION).toMatch(/^[0-9a-f]{8}$/);
    expect(computeColumnsVersion(COLUMNS)).toBe(COLUMNS_VERSION);
    expect(computeColumnsVersion(COLUMNS.slice(1))).not.toBe(COLUMNS_VERSION);
  });
});
