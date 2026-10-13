import { deriveOverlay, type Order, type OrderStateRecord } from '@apeiron/logos';
import { describe, expect, it } from 'vitest';
import { OrderModel } from './model';

const order = (over: Partial<Order> = {}): Order =>
  ({
    orderId: 'ALG00000001',
    currencyPair: 'EURUSD',
    side: 'BUY',
    status: 'LIVE',
    limitPrice: 1.1,
    avgFillPrice: null,
    arrivalPrice: 1.0,
    filledQty: 0,
    orderQty: 1_000_000,
    notionalUsd: 1_000_000,
    numFills: 0,
    marketBid: 1,
    marketAsk: 1,
    marketMid: 1,
    spreadBps: 0,
    distanceToLimitBps: 0,
    slippageBps: null,
    unrealisedPnlUsd: 0,
    lastUpdateTime: 1000,
    ...over,
  }) as unknown as Order;

describe('OrderModel', () => {
  const record = (o: Order, v: number): OrderStateRecord => ({ v, execSeq: 0, srcTs: 1, order: o });

  it('takes the newest record of each order and remembers creation order', () => {
    const model = new OrderModel([order()]);
    model.applyRecord(record(order({ orderId: 'ALG00000002' }), 1));
    model.applyRecord(record(order({ filledQty: 5, numFills: 1 }), 2));
    model.applyRecord(record(order({ orderId: 'ALG00000002', filledQty: 9 }), 2));
    expect(model.createdIds).toEqual(['ALG00000002']);
    expect(model.expected('ALG00000001')?.order).toMatchObject({ filledQty: 5, numFills: 1 });
    expect(model.expected('ALG00000002')?.order.filledQty).toBe(9);
    expect([...model.touchedIds].sort()).toEqual(['ALG00000001', 'ALG00000002']);
    expect(model.events).toBe(3);
  });

  it('ignores a record whose version is not above the one it holds', () => {
    const model = new OrderModel([]);
    model.applyRecord(record(order({ filledQty: 7 }), 3));
    model.applyRecord(record(order({ filledQty: 1 }), 3));
    model.applyRecord(record(order({ filledQty: 2 }), 2));
    expect(model.expected('ALG00000001')?.order.filledQty).toBe(7);
    expect(model.events).toBe(1);
  });

  it('reprices open orders from the latest tick with the shared logos function', () => {
    const model = new OrderModel([order({ avgFillPrice: 1.01, filledQty: 100 })]);
    model.applyTick({ pair: 'EURUSD', bid: 1.0, ask: 1.0004, ts: 1 });
    model.applyTick({ pair: 'EURUSD', bid: 1.2, ask: 1.2004, ts: 2 });
    const expected = model.expected('ALG00000001');
    const direct = deriveOverlay(order({ avgFillPrice: 1.01, filledQty: 100 }), { bid: 1.2, ask: 1.2004 });
    expect(expected?.order.marketMid).toBe(direct.marketMid);
    expect(expected?.order.unrealisedPnlUsd).toBe(direct.unrealisedPnlUsd);
    expect([...(expected?.excluded ?? [])]).toEqual([]);
  });

  it('does not reprice closed orders: they show what their last event left, and nothing is excluded', () => {
    const model = new OrderModel([order({ status: 'FILLED' })]);
    model.applyTick({ pair: 'EURUSD', bid: 1.2, ask: 1.2004, ts: 2 });
    const expected = model.expected('ALG00000001');
    expect(expected?.order.marketMid).toBe(1);
    expect(expected?.excluded.size).toBe(0);
  });

  it('lists what to verify: touched orders plus repriced open orders', () => {
    const model = new OrderModel([order(), order({ orderId: 'ALG00000009', status: 'PENDING_START' })]);
    model.applyTick({ pair: 'EURUSD', bid: 1, ask: 1.0002, ts: 1 });
    model.applyRecord({ v: 2, execSeq: 1, srcTs: 1, order: order({ orderId: 'ALG00000009', status: 'PENDING_START', filledQty: 0 }) });
    expect(model.idsToVerify().sort()).toEqual(['ALG00000001', 'ALG00000009']);
    expect(model.liveIds()).toEqual(['ALG00000001']);
    expect(model.statusOf('ALG00000009')).toBe('PENDING_START');
    expect(model.expected('missing')).toBeUndefined();
  });
});
