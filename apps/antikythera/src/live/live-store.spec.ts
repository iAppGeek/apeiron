import type { Order, PriceTick } from '@apeiron/logos';
import { describe, expect, it, vi } from 'vitest';
import { recordOf } from '../testing/bucket.js';
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
  lastUpdateTime: 0,
};

const tick = (pair: PriceTick['pair'], bid: number, ask: number): PriceTick => ({ pair, bid, ask, ts: 1 });

let revision = 0;

/** Queues the order service's next record for a row: the order as the store holds it with `patch` applied, one version up. */
function change(live: LiveStore, store: ReturnType<typeof makeStore>, orderId: string, patch: Partial<Order>, srcTs = 1): number {
  const row = store.rowIndexOf(orderId) as number;
  const v = store.versionAt(row) + 1;
  live.enqueueRecord({ ...recordOf({ ...store.orderAt(row), ...patch }, v), srcTs }, ++revision);
  return v;
}

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

describe('LiveStore records', () => {
  it('appends a record for an order it does not hold, in the ChangeSet and counters, with its version', () => {
    const { store, live } = setup([{ ...LIVE_EURUSD }]);
    const [fresh] = makeOrders([{}, { ...LIVE_EURUSD, traderId: 'T3' }]).slice(1) as [Order];
    live.enqueueRecord(recordOf(fresh, 4), 10);
    expect(live.pendingEvents).toBe(1);
    const cs = live.flush(1_000);
    expect(live.pendingEvents).toBe(0);
    expect(store.size).toBe(2);
    expect(store.versionAt(1)).toBe(4);
    expect(cs.entries.get(1)?.isNew).toBe(true);
    expect(live.counters.scoped('T3').byStatus.LIVE).toBe(1);
    expect(live.liveRows).toBe(2);
    expect(live.stats).toMatchObject({ recordsApplied: 1, rowsAppended: 1 });
  });

  it('applies a newer record over a row and records the changed fields', () => {
    const { store, live } = setup([{ ...LIVE_EURUSD }]);
    const id = store.orderAt(0).orderId;
    const v = change(live, store, id, { filledQty: 700_000, remainingQty: 300_000, numFills: 9 });
    const first = live.flush(1_000);
    for (const f of ['filledQty', 'remainingQty', 'numFills'] as const) expect(first.entries.get(0)?.fields.has(f)).toBe(true);
    expect(store.orderAt(0)).toMatchObject({ filledQty: 700_000, remainingQty: 300_000, numFills: 9 });
    expect(store.versionAt(0)).toBe(v);
  });

  it('ignores a record whose version is not above the row’s: a replay, or a rebuilt projection', () => {
    const { store, live } = setup([{ ...LIVE_EURUSD }]);
    const id = store.orderAt(0).orderId;
    const v = change(live, store, id, { filledQty: 700_000 });
    live.flush(1_000);
    live.enqueueRecord(recordOf({ ...store.orderAt(0), filledQty: 1 }, v), 20);
    live.enqueueRecord(recordOf({ ...store.orderAt(0), filledQty: 2 }, v - 1), 21);
    expect(live.flush(2_000).size).toBe(0);
    expect(store.orderAt(0).filledQty).toBe(700_000);
    expect(live.stats.recordsStale).toBe(2);
  });

  it('takes the later of two records for one order queued in the same flush', () => {
    const { store, live } = setup([{ ...LIVE_EURUSD }]);
    const id = store.orderAt(0).orderId;
    live.enqueueRecord(recordOf({ ...store.orderAt(0), filledQty: 500_000 }, 2), 1);
    live.enqueueRecord(recordOf({ ...store.orderAt(0), filledQty: 600_000 }, 3), 2);
    live.flush(1_000);
    expect(store.orderAt(0).filledQty).toBe(600_000);
    expect(store.versionAt(store.rowIndexOf(id) as number)).toBe(3);
  });

  it('keeps counters and the live index in step with status changes', () => {
    const { store, live } = setup([{ ...LIVE_EURUSD }, { ...LIVE_EURUSD, status: 'PENDING_START', traderId: 'T2' }]);
    const [a, b] = [store.orderAt(0).orderId, store.orderAt(1).orderId] as [string, string];
    change(live, store, a, { status: 'FILLED' });
    change(live, store, b, { status: 'LIVE' });
    live.flush(1_000);
    expect(live.counters.scoped('ALL').byStatus).toMatchObject({ LIVE: 1, FILLED: 1, PENDING_START: 0 });
    expect(live.counters.scoped('T1').liveNotionalUsd).toBe(0);
    expect(live.counters.scoped('T2').liveNotionalUsd).toBe(1_080_000);
    expect(live.liveRows).toBe(1);
    change(live, store, b, { status: 'PAUSED' });
    live.flush(2_000);
    expect(live.liveRows).toBe(1);
    change(live, store, b, { status: 'CANCELLED' });
    live.flush(3_000);
    expect(live.liveRows).toBe(0);
  });

  it('remembers the highest revision it has applied', () => {
    const { store, live } = setup([{ ...LIVE_EURUSD }]);
    live.noteRevision(5);
    expect(live.appliedRevision).toBe(5);
    const id = store.orderAt(0).orderId;
    change(live, store, id, { filledQty: 1 });
    change(live, store, id, { filledQty: 2 });
    live.flush(1_000);
    expect(live.appliedRevision).toBe(revision);
    expect(live.appliedRevision).toBeGreaterThan(5);
  });
});

describe('LiveStore price join', () => {
  it('recomputes the price-derived fields of that pair’s LIVE and PAUSED rows only', () => {
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

  it('ignores a tick older than the one it already holds (a replayed last value)', () => {
    const { store, live } = setup([{ ...LIVE_EURUSD }]);
    live.enqueueTick({ pair: 'EURUSD', bid: 1.0899, ask: 1.0901, ts: 500 });
    live.enqueueTick({ pair: 'EURUSD', bid: 1.0, ask: 1.0002, ts: 100 });
    live.flush(1_000);
    expect(store.orderAt(0).marketMid).toBe(1.09);
    expect(live.lastTickTs()).toEqual({ EURUSD: 500 });
    expect(live.pairsWithPrice).toBe(1);
  });

  it('reprices a row touched by a record with the latest tick even when its pair is quiet', () => {
    const { store, live } = setup([{ ...LIVE_EURUSD }]);
    live.enqueueTick(tick('EURUSD', 1.0899, 1.0901));
    live.flush(1_000);
    const pnl = store.orderAt(0).unrealisedPnlUsd;
    change(live, store, store.orderAt(0).orderId, { filledQty: 800_000, remainingQty: 200_000 });
    live.flush(2_000);
    expect(store.orderAt(0).unrealisedPnlUsd).toBeCloseTo(pnl * 2, 0);
    expect(store.orderAt(0).lastUpdateTime).toBe(2_000);
  });

  it('keeps the live price for an open order when a record carries an older market snapshot', () => {
    const { store, live } = setup([{ ...LIVE_EURUSD }]);
    live.enqueueTick(tick('EURUSD', 1.0899, 1.0901));
    live.flush(1_000);
    const id = store.orderAt(0).orderId;
    change(live, store, id, { filledQty: 500_000, marketBid: 1.0, marketAsk: 1.0002, marketMid: 1.0001 });
    const cs = live.flush(2_000);
    expect(store.orderAt(0)).toMatchObject({ marketBid: 1.0899, marketAsk: 1.0901, marketMid: 1.09, filledQty: 500_000 });
    // The overlay never flickered to the record's snapshot and back: those fields are not in the tick's changes.
    expect(cs.entries.get(0)?.fields.has('marketMid')).toBe(false);
    expect(cs.entries.get(0)?.fields.has('filledQty')).toBe(true);
  });

  it('takes the market snapshot of a record for an order that is no longer open', () => {
    const { store, live } = setup([{ ...LIVE_EURUSD }]);
    live.enqueueTick(tick('EURUSD', 1.0899, 1.0901));
    live.flush(1_000);
    change(live, store, store.orderAt(0).orderId, { status: 'FILLED', marketBid: 1.0799, marketAsk: 1.0801, marketMid: 1.08, unrealisedPnlUsd: 0 });
    live.flush(2_000);
    expect(store.orderAt(0)).toMatchObject({ status: 'FILLED', marketMid: 1.08, marketBid: 1.0799 });
  });

  it('never moves lastUpdateTime backwards, whichever clock stamped the change', () => {
    const { store, live } = setup([{ ...LIVE_EURUSD }]);
    const id = store.orderAt(0).orderId;
    change(live, store, id, { filledQty: 100_000, lastUpdateTime: 10_000 });
    live.flush(9_997);
    expect(store.orderAt(0).lastUpdateTime).toBe(10_000);
    // The server's clock is three milliseconds behind the producer's: a reprice must not step back.
    live.enqueueTick(tick('EURUSD', 1.0899, 1.0901));
    live.flush(9_998);
    expect(store.orderAt(0).lastUpdateTime).toBe(10_000);
    // A late record stamped earlier than what the row already shows keeps the later time but still applies its fields.
    change(live, store, id, { filledQty: 200_000, lastUpdateTime: 9_990 });
    live.flush(9_999);
    expect(store.orderAt(0)).toMatchObject({ lastUpdateTime: 10_000, filledQty: 200_000 });
    live.enqueueTick({ ...tick('EURUSD', 1.0898, 1.09), ts: 2 });
    live.flush(10_500);
    expect(store.orderAt(0).lastUpdateTime).toBe(10_500);
  });

  it('prices a new order that arrives after the pair has ticked', () => {
    const { store, live } = setup([{ ...LIVE_EURUSD }]);
    live.enqueueTick(tick('EURUSD', 1.0899, 1.0901));
    live.flush(1_000);
    const [fresh] = makeOrders([{}, { ...LIVE_EURUSD }]).slice(1) as [Order];
    live.enqueueRecord(recordOf(fresh), 5);
    live.flush(2_000);
    expect(store.orderAt(1).marketMid).toBe(1.09);
  });

  it('stops repricing a row once it is no longer open', () => {
    const { store, live } = setup([{ ...LIVE_EURUSD }]);
    change(live, store, store.orderAt(0).orderId, { status: 'FILLED' });
    live.flush(1_000);
    live.enqueueTick(tick('EURUSD', 1.2, 1.2002));
    expect(live.flush(2_000).size).toBe(0);
  });
});

describe('LiveStore.lastFlushAgeMs', () => {
  it('is the age of the oldest queued record or tick, and null when nothing was applied', () => {
    const { live, store } = setup([{ ...LIVE_EURUSD }]);
    const id = store.orderAt(0).orderId;
    expect(live.lastFlushAgeMs).toBeNull();
    live.flush(1_000);
    expect(live.lastFlushAgeMs).toBeNull();
    change(live, store, id, { numFills: 1 }, 900);
    live.enqueueTick({ pair: 'EURUSD', bid: 1.08, ask: 1.0802, ts: 950 });
    live.flush(1_000);
    expect(live.lastFlushAgeMs).toBe(100);
    live.enqueueTick({ pair: 'EURUSD', bid: 1.08, ask: 1.0802, ts: 2_000 });
    live.flush(1_500);
    expect(live.lastFlushAgeMs).toBe(0);
  });
});

describe('LiveStore source timestamps', () => {
  it('stamps each changed row with the source record or price tick behind it', () => {
    const { live, store } = setup([{ ...LIVE_EURUSD }, { ...LIVE_EURUSD, orderQty: 5 }]);
    const first = store.orderAt(0).orderId;
    change(live, store, first, { numFills: 1 }, 900);
    live.enqueueTick({ pair: 'EURUSD', bid: 1.09, ask: 1.0902, ts: 950 });
    const cs = live.flush(1_000);
    // The first row was touched by the record (900) and the tick (950); the second only by the tick.
    expect(cs.entries.get(0)?.ts).toBe(900);
    expect(cs.entries.get(1)?.ts).toBe(950);
    expect(cs.srcTs).toBe(900);
  });

  it('does not blame a record-driven repricing on an older price tick', () => {
    const { live, store } = setup([{ ...LIVE_EURUSD }]);
    live.enqueueTick({ pair: 'EURUSD', bid: 1.09, ask: 1.0902, ts: 100 });
    live.flush(200);
    change(live, store, store.orderAt(0).orderId, { filledQty: 900_000, remainingQty: 100_000 }, 950);
    const cs = live.flush(1_000);
    expect(cs.entries.get(0)?.ts).toBe(950);
  });

  it('stamps appended rows with their record', () => {
    const { live, store } = setup([{ ...LIVE_EURUSD }]);
    const fresh = makeOrders([{ ...LIVE_EURUSD, createdAt: 99_999 }])[0] as Order;
    live.enqueueRecord({ ...recordOf({ ...fresh, orderId: 'NEW-1' }), srcTs: 777 }, 3);
    const cs = live.flush(1_000);
    expect(cs.entries.get(store.size - 1)).toMatchObject({ isNew: true, ts: 777 });
  });
});
