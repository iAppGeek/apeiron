import { describe, expect, it } from 'vitest';
import { generateOrders, PAIRS } from '@apeiron/logos';
import { DEFAULT_BATCH_SIZE, latestMidsOf, toStoredOrder } from './order-repository.js';

describe('order-repository', () => {
  it('defaults to 10k batches', () => {
    expect(DEFAULT_BATCH_SIZE).toBe(10_000);
  });

  it('wraps a fresh order with v = 1 and execSeq = numFills', () => {
    const order = { ...(generateOrders(1, 100_000, Date.UTC(2026, 9, 6, 12)).next().value as never as Record<string, unknown>), numFills: 3 };
    expect(toStoredOrder(order as never)).toEqual({ order, v: 1, execSeq: 3 });
  });

  it('latestMidsOf falls back to the reference level and breaks ties by orderId', () => {
    const [a, b] = [...generateOrders(1, 100_000, Date.UTC(2026, 9, 6, 12))].slice(0, 2);
    if (a === undefined || b === undefined) throw new Error('no orders');
    const tie = [
      { ...a, orderId: 'ALG00000001', currencyPair: 'EURUSD' as const, lastUpdateTime: 5, marketMid: 1.1 },
      { ...b, orderId: 'ALG00000002', currencyPair: 'EURUSD' as const, lastUpdateTime: 5, marketMid: 1.2 },
    ];
    const mids = latestMidsOf(tie);
    expect(mids.EURUSD).toBe(1.2);
    expect(mids.GBPUSD).toBe(PAIRS.find((p) => p.pair === 'GBPUSD')?.mid);
  });
});
