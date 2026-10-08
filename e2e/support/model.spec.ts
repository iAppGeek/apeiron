import { derivePriceFields, type Order, type OrderEvent } from '@apeiron/logos';
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
  it('upserts NEW, merges UPDATE and remembers creation order', () => {
    const model = new OrderModel([order()]);
    const events: OrderEvent[] = [
      { type: 'NEW', order: order({ orderId: 'ALG00000002' }), ts: 1 },
      { type: 'UPDATE', order: { orderId: 'ALG00000001', filledQty: 5, numFills: 1 }, ts: 2 },
      { type: 'NEW', order: order({ orderId: 'ALG00000002', filledQty: 9 }), ts: 3 },
    ];
    for (const e of events) model.applyEvent(e);
    expect(model.createdIds).toEqual(['ALG00000002']);
    expect(model.expected('ALG00000001')?.order).toMatchObject({ filledQty: 5, numFills: 1 });
    expect(model.expected('ALG00000002')?.order.filledQty).toBe(9);
    expect([...model.touchedIds].sort()).toEqual(['ALG00000001', 'ALG00000002']);
    expect(model.events).toBe(3);
  });

  it('counts an update for an unknown order and ignores rejects', () => {
    const model = new OrderModel([]);
    model.applyEvent({ type: 'UPDATE', order: { orderId: 'X', filledQty: 1 }, ts: 1 });
    model.applyEvent({ type: 'REJECT', commandId: 'c', orderId: 'X', code: 'UNKNOWN_ORDER', message: '', ts: 2 });
    expect(model.unknown).toBe(1);
    expect(model.events).toBe(1);
  });

  it('reprices open orders from the latest tick with the shared logos function', () => {
    const model = new OrderModel([order({ avgFillPrice: 1.01, filledQty: 100 })]);
    model.applyTick({ pair: 'EURUSD', bid: 1.0, ask: 1.0004, ts: 1 });
    model.applyTick({ pair: 'EURUSD', bid: 1.2, ask: 1.2004, ts: 2 });
    const expected = model.expected('ALG00000001');
    const direct = derivePriceFields(order({ avgFillPrice: 1.01, filledQty: 100 }), { bid: 1.2, ask: 1.2004 }, 0);
    expect(expected?.order.marketMid).toBe(direct.marketMid);
    expect(expected?.order.unrealisedPnlUsd).toBe(direct.unrealisedPnlUsd);
    expect([...(expected?.excluded ?? [])]).toEqual(['lastUpdateTime']);
  });

  it('does not reprice closed orders, and excludes their quote fields from comparison', () => {
    const model = new OrderModel([order({ status: 'FILLED' })]);
    model.applyTick({ pair: 'EURUSD', bid: 1.2, ask: 1.2004, ts: 2 });
    const expected = model.expected('ALG00000001');
    expect(expected?.order.marketMid).toBe(1);
    expect(expected?.excluded.has('marketMid')).toBe(true);
    expect(expected?.excluded.has('filledQty')).toBe(false);
  });

  it('lists what to verify: touched orders plus repriced open orders', () => {
    const model = new OrderModel([order(), order({ orderId: 'ALG00000009', status: 'PENDING_START' })]);
    model.applyTick({ pair: 'EURUSD', bid: 1, ask: 1.0002, ts: 1 });
    model.applyEvent({ type: 'UPDATE', order: { orderId: 'ALG00000009', filledQty: 0 }, ts: 1 });
    expect(model.idsToVerify().sort()).toEqual(['ALG00000001', 'ALG00000009']);
    expect(model.liveIds()).toEqual(['ALG00000001']);
    expect(model.statusOf('ALG00000009')).toBe('PENDING_START');
    expect(model.expected('missing')).toBeUndefined();
  });
});
