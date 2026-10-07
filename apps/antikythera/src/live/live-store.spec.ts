import type { Order, OrderEvent, PriceTick } from '@apeiron/logos';
import { describe, expect, it, vi } from 'vitest';
import { makeOrders, makeStore } from '../testing/orders.js';
import { LiveStore } from './live-store.js';

const log = { warn: vi.fn() };

function setup(rows: Partial<Order>[]): { store: ReturnType<typeof makeStore>; live: LiveStore } {
  const store = makeStore(rows);
  const live = new LiveStore(store, log);
  live.init();
  return { store, live };
}

const LIVE_EURUSD: Partial<Order> = {
  status: 'LIVE',
  currencyPair: 'EURUSD',
  side: 'BUY',
  traderId: 'T1',
  orderQty: 1_000_000,
  filledQty: 400_000,
  remainingQty: 600_000,
  avgFillPrice: 1.08,
  arrivalPrice: 1.08,
  notionalUsd: 1_080_000,
  limitPrice: 1.09,
  marketMid: 1.08,
  marketBid: 1.0799,
  marketAsk: 1.0801,
};

const tick = (pair: PriceTick['pair'], bid: number, ask: number): PriceTick => ({ pair, bid, ask, ts: 1 });
const update = (orderId: string, order: Partial<Order>): OrderEvent => ({ type: 'UPDATE', order: { orderId, ...order }, ts: 1 });
const ack = (): void => undefined;

describe('LiveStore.init', () => {
  it('builds status counters and the live-by-pair index from the loaded store', () => {
    const { live } = setup([
      { ...LIVE_EURUSD },
      { ...LIVE_EURUSD, status: 'PAUSED' },
      { ...LIVE_EURUSD, status: 'FILLED', traderId: 'T2' },
      { ...LIVE_EURUSD, status: 'PENDING_START' },
    ]);
    expect(live.liveRows).toBe(2);
    expect(live.counters.scoped('ALL').byStatus).toMatchObject({ LIVE: 1, PAUSED: 1, FILLED: 1, PENDING_START: 1 });
    expect(live.counters.scoped('T1').liveNotionalUsd).toBe(1_080_000);
    expect(live.counters.scoped('T2').byStatus.FILLED).toBe(1);
  });
});

describe('LiveStore events', () => {
  it('appends a NEW order, records it in the ChangeSet and counters, and marks it for write-behind', () => {
    const { store, live } = setup([{ ...LIVE_EURUSD }]);
    const [fresh] = makeOrders([{}, { ...LIVE_EURUSD, traderId: 'T3' }]).slice(1) as [Order];
    live.enqueueEvent({ type: 'NEW', order: fresh, ts: 1 }, ack);
    expect(live.pendingEvents).toBe(1);
    const cs = live.flush(1_000);
    expect(live.pendingEvents).toBe(0);
    expect(store.size).toBe(2);
    expect(cs.entries.get(1)?.isNew).toBe(true);
    expect(live.counters.scoped('T3').byStatus.LIVE).toBe(1);
    expect(live.liveRows).toBe(2);
    expect(live.takeWriteBatch().orders.map((o) => o.orderId)).toEqual([fresh.orderId]);
  });

  it('treats a NEW for an order already stored as an idempotent upsert', () => {
    const { store, live } = setup([{ ...LIVE_EURUSD }]);
    const existing = store.orderAt(0);
    live.enqueueEvent({ type: 'NEW', order: { ...existing, filledQty: 500_000, remainingQty: 500_000 }, ts: 1 }, ack);
    const cs = live.flush(1_000);
    expect(store.size).toBe(1);
    expect(cs.entries.get(0)?.isNew).toBe(false);
    expect(cs.entries.get(0)?.fields.has('filledQty')).toBe(true);
    expect(live.counters.scoped('ALL').byStatus.LIVE).toBe(1);
  });

  it('applies absolute UPDATE values and is idempotent when replayed', () => {
    const { store, live } = setup([{ ...LIVE_EURUSD }]);
    const id = store.orderAt(0).orderId;
    const event = update(id, { filledQty: 700_000, remainingQty: 300_000, numFills: 9 });
    live.enqueueEvent(event, ack);
    const first = live.flush(1_000);
    for (const f of ['filledQty', 'remainingQty', 'numFills'] as const) expect(first.entries.get(0)?.fields.has(f)).toBe(true);
    expect(store.orderAt(0)).toMatchObject({ filledQty: 700_000, remainingQty: 300_000, numFills: 9 });
    live.takeWriteBatch();
    live.enqueueEvent(event, ack);
    const replay = live.flush(2_000);
    expect(replay.size).toBe(0);
    expect(live.takeWriteBatch().orders).toEqual([]);
    expect(store.orderAt(0).filledQty).toBe(700_000);
  });

  it('counts and drops events for unknown orders and ignores REJECT events', () => {
    const { live } = setup([{ ...LIVE_EURUSD }]);
    live.enqueueEvent(update('NOPE', { filledQty: 1 }), ack);
    live.enqueueEvent({ type: 'REJECT', commandId: 'c:1', orderId: 'x', code: 'UNKNOWN_ORDER', message: 'm', ts: 1 }, ack);
    const cs = live.flush(1_000);
    expect(cs.size).toBe(0);
    expect(live.stats.unknownOrders).toBe(1);
    expect(log.warn).toHaveBeenCalled();
  });

  it('keeps counters and the live index in step with status changes', () => {
    const { store, live } = setup([{ ...LIVE_EURUSD }, { ...LIVE_EURUSD, status: 'PENDING_START', traderId: 'T2' }]);
    const [a, b] = [store.orderAt(0).orderId, store.orderAt(1).orderId] as [string, string];
    live.enqueueEvent(update(a, { status: 'FILLED' }), ack);
    live.enqueueEvent(update(b, { status: 'LIVE' }), ack);
    live.flush(1_000);
    expect(live.counters.scoped('ALL').byStatus).toMatchObject({ LIVE: 1, FILLED: 1, PENDING_START: 0 });
    expect(live.counters.scoped('T1').liveNotionalUsd).toBe(0);
    expect(live.counters.scoped('T2').liveNotionalUsd).toBe(1_080_000);
    expect(live.liveRows).toBe(1);
    live.enqueueEvent(update(b, { status: 'PAUSED' }), ack);
    live.flush(2_000);
    expect(live.liveRows).toBe(1);
    live.enqueueEvent(update(b, { status: 'CANCELLED' }), ack);
    live.flush(3_000);
    expect(live.liveRows).toBe(0);
  });
});

describe('LiveStore price join', () => {
  it('recomputes the price-derived fields of that pair’s LIVE and PAUSED rows only, and never persists them', () => {
    const { store, live } = setup([
      { ...LIVE_EURUSD },
      { ...LIVE_EURUSD, status: 'PAUSED' },
      { ...LIVE_EURUSD, status: 'FILLED' },
      { ...LIVE_EURUSD, currencyPair: 'GBPUSD', arrivalPrice: 1.27 },
    ]);
    const before = [0, 1, 2, 3].map((r) => store.orderAt(r).marketMid);
    live.enqueueTick(tick('EURUSD', 1.0899, 1.0901));
    const cs = live.flush(5_000);
    expect([...cs.entries.keys()].sort()).toEqual([0, 1]);
    for (const row of [0, 1]) {
      expect(store.orderAt(row)).toMatchObject({ marketBid: 1.0899, marketAsk: 1.0901, marketMid: 1.09, lastUpdateTime: 5_000 });
      expect(store.orderAt(row).unrealisedPnlUsd).toBeGreaterThan(0);
      expect(store.orderAt(row).distanceToLimitBps).toBeCloseTo(0, 1);
    }
    expect([2, 3].map((r) => store.orderAt(r).marketMid)).toEqual([before[2], before[3]]);
    expect(live.takeWriteBatch().orders).toEqual([]);
    expect(live.stats.priceRecomputes).toBe(2);
  });

  it('conflates several ticks of a pair into one recompute at the latest quote', () => {
    const { store, live } = setup([{ ...LIVE_EURUSD }]);
    live.enqueueTick(tick('EURUSD', 1.0, 1.0002));
    live.enqueueTick(tick('EURUSD', 1.0899, 1.0901));
    live.flush(5_000);
    expect(store.orderAt(0).marketMid).toBe(1.09);
    expect(live.stats.priceRecomputes).toBe(1);
  });

  it('reprices a row touched by an event with the latest tick even when its pair is quiet', () => {
    const { store, live } = setup([{ ...LIVE_EURUSD }]);
    live.enqueueTick(tick('EURUSD', 1.0899, 1.0901));
    live.flush(1_000);
    const pnl = store.orderAt(0).unrealisedPnlUsd;
    live.enqueueEvent(update(store.orderAt(0).orderId, { filledQty: 800_000, remainingQty: 200_000 }), ack);
    live.flush(2_000);
    expect(store.orderAt(0).unrealisedPnlUsd).toBeCloseTo(pnl * 2, 0);
    expect(store.orderAt(0).lastUpdateTime).toBe(2_000);
  });

  it('prices a NEW order that arrives after the pair has ticked', () => {
    const { store, live } = setup([{ ...LIVE_EURUSD }]);
    live.enqueueTick(tick('EURUSD', 1.0899, 1.0901));
    live.flush(1_000);
    const [fresh] = makeOrders([{}, { ...LIVE_EURUSD }]).slice(1) as [Order];
    live.enqueueEvent({ type: 'NEW', order: fresh, ts: 2 }, ack);
    live.flush(2_000);
    expect(store.orderAt(1).marketMid).toBe(1.09);
  });

  it('stops repricing a row once it is no longer open', () => {
    const { store, live } = setup([{ ...LIVE_EURUSD }]);
    live.enqueueEvent(update(store.orderAt(0).orderId, { status: 'FILLED' }), ack);
    live.flush(1_000);
    live.enqueueTick(tick('EURUSD', 1.2, 1.2002));
    expect(live.flush(2_000).size).toBe(0);
  });
});

describe('LiveStore write batches', () => {
  it('rebuilds full orders from the store and hands over the last ack once', () => {
    const { store, live } = setup([{ ...LIVE_EURUSD }]);
    const first = vi.fn();
    const second = vi.fn();
    const id = store.orderAt(0).orderId;
    live.enqueueEvent(update(id, { numFills: 3 }), first);
    live.enqueueEvent(update(id, { numFills: 4 }), second);
    live.flush(1_000);
    const batch = live.takeWriteBatch();
    expect(batch.orders).toHaveLength(1);
    expect(Object.keys(batch.orders[0] as Order)).toHaveLength(50);
    expect(batch.orders[0]?.numFills).toBe(4);
    batch.ack?.();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(live.takeWriteBatch()).toEqual({ orders: [], ack: null });
  });

  it('puts a failed batch back for the next pass', () => {
    const { store, live } = setup([{ ...LIVE_EURUSD }]);
    const done = vi.fn();
    live.enqueueEvent(update(store.orderAt(0).orderId, { numFills: 3 }), done);
    live.flush(1_000);
    const batch = live.takeWriteBatch();
    live.restoreWriteBatch(batch);
    const again = live.takeWriteBatch();
    expect(again.orders.map((o) => o.orderId)).toEqual(batch.orders.map((o) => o.orderId));
    again.ack?.();
    expect(done).toHaveBeenCalledTimes(1);
  });
});

describe('LiveStore.lastFlushAgeMs', () => {
  it('is the age of the oldest queued event or tick, and null when nothing was applied', () => {
    const { live, store } = setup([{ ...LIVE_EURUSD }]);
    const id = store.orderAt(0).orderId;
    expect(live.lastFlushAgeMs).toBeNull();
    live.flush(1_000);
    expect(live.lastFlushAgeMs).toBeNull();
    live.enqueueEvent({ type: 'UPDATE', order: { orderId: id, numFills: 1 }, ts: 900 }, ack);
    live.enqueueTick({ pair: 'EURUSD', bid: 1.08, ask: 1.0802, ts: 950 });
    live.flush(1_000);
    expect(live.lastFlushAgeMs).toBe(100);
    live.enqueueTick({ pair: 'EURUSD', bid: 1.08, ask: 1.0802, ts: 2_000 });
    live.flush(1_500);
    expect(live.lastFlushAgeMs).toBe(0);
  });
});

describe('LiveStore source timestamps', () => {
  it('stamps each changed row with the source event or price tick behind it', () => {
    const { live, store } = setup([{ ...LIVE_EURUSD }, { ...LIVE_EURUSD, orderQty: 5 }]);
    const [first, second] = [store.orderAt(0).orderId, store.orderAt(1).orderId];
    live.enqueueEvent({ type: 'UPDATE', order: { orderId: first, numFills: 1 }, ts: 900 }, ack);
    live.enqueueTick({ pair: 'EURUSD', bid: 1.09, ask: 1.0902, ts: 950 });
    const cs = live.flush(1_000);
    // The first row was touched by the event (900) and the tick (950); the second only by the tick.
    expect(cs.entries.get(0)?.ts).toBe(900);
    expect(cs.entries.get(1)?.ts).toBe(950);
    expect(cs.srcTs).toBe(900);
    expect(second).toBeDefined();
  });

  it('does not blame an event-driven repricing on an older price tick', () => {
    const { live, store } = setup([{ ...LIVE_EURUSD }]);
    live.enqueueTick({ pair: 'EURUSD', bid: 1.09, ask: 1.0902, ts: 100 });
    live.flush(200);
    live.enqueueEvent({ type: 'UPDATE', order: { orderId: store.orderAt(0).orderId, filledQty: 900_000, remainingQty: 100_000 }, ts: 950 }, ack);
    const cs = live.flush(1_000);
    expect(cs.entries.get(0)?.ts).toBe(950);
  });

  it('stamps appended rows with their event', () => {
    const { live, store } = setup([{ ...LIVE_EURUSD }]);
    const fresh = makeOrders([{ ...LIVE_EURUSD, createdAt: 99_999 }])[0] as Order;
    live.enqueueEvent({ type: 'NEW', order: { ...fresh, orderId: 'NEW-1' }, ts: 777 }, ack);
    const cs = live.flush(1_000);
    expect(cs.entries.get(store.size - 1)).toMatchObject({ isNew: true, ts: 777 });
  });
});
