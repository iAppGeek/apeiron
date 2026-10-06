import { describe, expect, it } from 'vitest';
import { CURRENCY_PAIRS, PAIRS, PAIR_BY_NAME, TRADERS, TRADER_SPECS } from './order.js';

describe('order reference data', () => {
  it('has 20 pairs whose weights sum to 1', () => {
    expect(PAIRS).toHaveLength(20);
    expect(PAIRS.map((p) => p.pair)).toEqual([...CURRENCY_PAIRS]);
    expect(PAIRS.reduce((s, p) => s + p.weight, 0)).toBeCloseTo(1, 10);
  });

  it('assigns the named pair weights', () => {
    const w = (pair: (typeof CURRENCY_PAIRS)[number]): number => PAIR_BY_NAME.get(pair)?.weight ?? 0;
    expect(w('EURUSD')).toBe(0.25);
    expect(w('USDJPY')).toBe(0.15);
    expect(w('GBPUSD')).toBe(0.12);
    expect(w('AUDUSD')).toBe(0.07);
    expect(w('USDCAD')).toBe(0.06);
    expect(w('USDCHF')).toBeCloseTo(0.35 / 15, 10);
  });

  it('splits base and quote currency from the pair name', () => {
    expect(PAIR_BY_NAME.get('EURJPY')).toMatchObject({ base: 'EUR', quote: 'JPY', decimals: 3, mid: 162 });
  });

  it('has 5 traders with 3 accounts each and weights summing to 1', () => {
    expect(TRADERS).toHaveLength(5);
    expect(TRADER_SPECS.every((t) => t.accounts.length === 3)).toBe(true);
    expect(TRADER_SPECS.reduce((s, t) => s + t.weight, 0)).toBeCloseTo(1, 10);
    expect(TRADER_SPECS.map((t) => t.weight)).toEqual([0.35, 0.25, 0.2, 0.12, 0.08]);
  });
});
