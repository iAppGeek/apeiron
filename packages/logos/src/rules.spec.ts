import { describe, expect, it } from 'vitest';
import { sampleOrders } from './fixtures.js';
import type { ExecReport, OrderStateRecord, Submission } from './contracts.js';
import type { Order } from './order.js';
import { applyAmend, applyExecReport, canAmend, checkAmend, recordFromSubmission, validateSubmission } from './rules.js';

const NOW = 1_800_000_000_000;
const QUOTE = { bid: 1.0799, ask: 1.0801 };

function record(overrides: Partial<Order> = {}, execSeq = 0, v = 3): OrderStateRecord {
  const base = sampleOrders(1)[0] as Order;
  const order: Order = {
    ...base,
    currencyPair: 'EURUSD',
    side: 'BUY',
    status: 'LIVE',
    orderQty: 1_000_000,
    filledQty: 0,
    remainingQty: 1_000_000,
    pctComplete: 0,
    notionalUsd: 1_080_000,
    filledNotionalUsd: 0,
    arrivalPrice: 1.08,
    avgFillPrice: null,
    lastFillPrice: null,
    lastFillQty: 0,
    numFills: 0,
    numChildOrders: 0,
    slippageBps: null,
    slippageUsd: 0,
    unrealisedPnlUsd: 0,
    realisedPnlUsd: 0,
    limitPrice: 1.082,
    completedAt: null,
    startTime: NOW - 600_000,
    endTime: NOW + 600_000,
    durationMins: 20,
    lastUpdateTime: NOW - 1000,
    urgency: 'MEDIUM',
    ...overrides,
  };
  return { v, execSeq, srcTs: NOW - 1000, order };
}

const fill = (execSeq: number, qty: number, price = 1.0802): Extract<ExecReport, { type: 'FILL' }> => ({ type: 'FILL', orderId: 'X', execSeq, qty, price, ts: NOW, ...QUOTE });

function applied(result: ReturnType<typeof applyExecReport>): OrderStateRecord {
  if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
  return result.record;
}

describe('applyExecReport', () => {
  it('ignores a report whose execSeq is not above the last accepted one', () => {
    expect(applyExecReport(record({}, 4), fill(4, 100)).kind).toBe('duplicate');
    expect(applyExecReport(record({}, 4), fill(2, 100)).kind).toBe('duplicate');
  });

  it('accepts gaps in execSeq', () => {
    expect(applied(applyExecReport(record({}, 1), fill(9, 100)))).toMatchObject({ execSeq: 9 });
  });

  it('applies a fill: v + 1, lastUpdateTime = ts, market snapshot from the report quote', () => {
    const next = applied(applyExecReport(record(), fill(1, 250_000)));
    expect(next.v).toBe(4);
    expect(next.srcTs).toBe(NOW);
    expect(next.order).toMatchObject({
      status: 'LIVE',
      filledQty: 250_000,
      remainingQty: 750_000,
      numFills: 1,
      avgFillPrice: 1.0802,
      lastUpdateTime: NOW,
      marketBid: 1.0799,
      marketAsk: 1.0801,
      marketMid: 1.08,
    });
    expect(next.order.unrealisedPnlUsd).not.toBe(0);
  });

  it('clamps a fill larger than what remains and completes the order', () => {
    const result = applyExecReport(record({ filledQty: 900_000, remainingQty: 100_000, avgFillPrice: 1.08, numFills: 3 }), fill(1, 400_000));
    expect(result).toMatchObject({ kind: 'applied', clamped: true });
    const next = applied(result);
    expect(next.order).toMatchObject({ status: 'FILLED', filledQty: 1_000_000, remainingQty: 0, completedAt: NOW, unrealisedPnlUsd: 0 });
  });

  it('does not report a clamp for an exact fill', () => {
    const result = applyExecReport(record({ filledQty: 900_000, remainingQty: 100_000, avgFillPrice: 1.08 }), fill(1, 100_000));
    expect(result).toMatchObject({ kind: 'applied', clamped: false });
  });

  it('books realised P&L at the completing report quote', () => {
    const base = record({ filledQty: 500_000, remainingQty: 500_000, avgFillPrice: 1.07, unrealisedPnlUsd: 111, marketMid: 1.5 });
    const next = applied(applyExecReport(base, { ...fill(1, 500_000), bid: 1.0899, ask: 1.0901 }));
    expect(next.order.status).toBe('FILLED');
    expect(next.order.marketMid).toBe(1.09);
    // 1,000,000 filled, average (1.07 + 1.0802) / 2 = 1.0751, mid 1.09, USD rate 1.08 per unit / 1.09
    expect(next.order.realisedPnlUsd).toBeGreaterThan(0);
    expect(next.order.realisedPnlUsd).toBeCloseTo(1_000_000 * (1.09 - 1.0751) * (1.08 / 1.09), -1);
  });

  it.each([
    ['PAUSED' as const],
    ['PENDING_START' as const],
    ['FILLED' as const],
    ['CANCELLED' as const],
  ])('rejects a fill on a %s order but still advances execSeq', (status) => {
    const result = applyExecReport(record({ status }, 2), fill(3, 100));
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') {
      expect(result.record.execSeq).toBe(3);
      expect(result.record.v).toBe(3);
      expect(result.record.order).toEqual(record({ status }, 2).order);
    }
  });

  it('rejects a fill with a non-positive price or quantity', () => {
    expect(applyExecReport(record(), fill(1, 0)).kind).toBe('rejected');
    expect(applyExecReport(record(), fill(1, -5)).kind).toBe('rejected');
    expect(applyExecReport(record(), fill(1, 100, 0)).kind).toBe('rejected');
  });

  it('activates only a PENDING_START order', () => {
    const activate: ExecReport = { type: 'ACTIVATED', orderId: 'X', execSeq: 1, ts: NOW };
    expect(applied(applyExecReport(record({ status: 'PENDING_START' }), activate)).order.status).toBe('LIVE');
    expect(applyExecReport(record({ status: 'LIVE' }), activate).kind).toBe('rejected');
  });

  it('cancels a live order: terminal fields, market snapshot, realised P&L at the quote mid', () => {
    const base = record({ filledQty: 500_000, remainingQty: 500_000, avgFillPrice: 1.07, unrealisedPnlUsd: 5 });
    const next = applied(applyExecReport(base, { type: 'CANCELLED', orderId: 'X', execSeq: 1, reason: 'TRADER', ts: NOW, ...QUOTE }));
    expect(next.order).toMatchObject({ status: 'CANCELLED', completedAt: NOW, unrealisedPnlUsd: 0, marketMid: 1.08 });
    expect(next.order.realisedPnlUsd).toBeGreaterThan(0);
  });

  it('cancels a PENDING_START order with no P&L, and rejects cancelling a terminal one', () => {
    const cancel: ExecReport = { type: 'CANCELLED', orderId: 'X', execSeq: 1, reason: 'EXPIRED', ts: NOW, ...QUOTE };
    expect(applied(applyExecReport(record({ status: 'PENDING_START' }), cancel)).order).toMatchObject({ status: 'CANCELLED', realisedPnlUsd: 0 });
    expect(applyExecReport(record({ status: 'FILLED' }), cancel).kind).toBe('rejected');
    expect(applyExecReport(record({ status: 'CANCELLED' }), cancel).kind).toBe('rejected');
  });

  it('pauses LIVE, and resumes PAUSED while extending endTime by the paused time', () => {
    const paused = applied(applyExecReport(record(), { type: 'PAUSED', orderId: 'X', execSeq: 1, instrId: 'c:1', ts: NOW }));
    expect(paused.order.status).toBe('PAUSED');
    const resumed = applied(applyExecReport(paused, { type: 'RESUMED', orderId: 'X', execSeq: 2, instrId: 'c:2', ts: NOW + 30_000 }));
    expect(resumed.order.status).toBe('LIVE');
    expect(resumed.order.endTime).toBe(paused.order.endTime + 30_000);
  });

  it('rejects pausing a PAUSED order and resuming a LIVE one', () => {
    expect(applyExecReport(record({ status: 'PAUSED' }), { type: 'PAUSED', orderId: 'X', execSeq: 1, instrId: 'c', ts: NOW }).kind).toBe('rejected');
    expect(applyExecReport(record(), { type: 'RESUMED', orderId: 'X', execSeq: 1, instrId: 'c', ts: NOW }).kind).toBe('rejected');
  });

  it('turns a VENUE_REJECT into a no-change result that carries the instruction id', () => {
    const result = applyExecReport(record({}, 1), { type: 'VENUE_REJECT', orderId: 'X', execSeq: 2, instrId: 'c:9', message: 'too late', ts: NOW });
    expect(result).toMatchObject({ kind: 'venue_reject', instrId: 'c:9', message: 'too late' });
    if (result.kind === 'venue_reject') expect(result.record).toEqual({ ...record({}, 1), execSeq: 2 });
  });

  it('does not mutate its input', () => {
    const base = record();
    const copy = structuredClone(base);
    applyExecReport(base, fill(1, 1000));
    expect(base).toEqual(copy);
  });
});

describe('applyAmend', () => {
  const ok = (result: ReturnType<typeof applyAmend>): OrderStateRecord => {
    if (!result.ok) throw new Error(result.message);
    return result.record;
  };

  it('changes the quantity and recomputes the derived fields at the same USD rate', () => {
    const base = record({ filledQty: 200_000, remainingQty: 800_000, pctComplete: 20, filledNotionalUsd: 216_000, avgFillPrice: 1.08 });
    const next = ok(applyAmend(base, { orderQty: 2_000_000 }, NOW));
    expect(next.v).toBe(4);
    expect(next.execSeq).toBe(base.execSeq);
    expect(next.order).toMatchObject({
      orderQty: 2_000_000,
      remainingQty: 1_800_000,
      pctComplete: 10,
      notionalUsd: 2_160_000,
      filledNotionalUsd: 216_000,
      lastUpdateTime: NOW,
    });
  });

  it('changes the limit price and its distance, and clears it with null', () => {
    const base = record({ marketMid: 1.08 });
    const next = ok(applyAmend(base, { limitPrice: 1.0822 }, NOW));
    expect(next.order.limitPrice).toBe(1.0822);
    expect(next.order.distanceToLimitBps).toBe(20.37);
    expect(ok(applyAmend(base, { limitPrice: null }, NOW)).order).toMatchObject({ limitPrice: null, distanceToLimitBps: null });
  });

  it('changes the end time and duration, and the urgency', () => {
    const base = record();
    const next = ok(applyAmend(base, { endTime: base.order.startTime + 45 * 60_000, urgency: 'HIGH' }, NOW));
    expect(next.order).toMatchObject({ durationMins: 45, urgency: 'HIGH' });
  });

  it('allows amending PENDING_START, LIVE and PAUSED only', () => {
    for (const status of ['PENDING_START', 'LIVE', 'PAUSED'] as const) expect(applyAmend(record({ status }), { urgency: 'LOW' }, NOW).ok).toBe(true);
    for (const status of ['FILLED', 'CANCELLED'] as const) {
      expect(applyAmend(record({ status }), { urgency: 'LOW' }, NOW)).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
    }
  });

  it.each([
    ['a quantity at or below the filled quantity', { orderQty: 200_000 }],
    ['a fractional quantity', { orderQty: 1_000_000.5 }],
    ['a zero limit price', { limitPrice: 0 }],
    ['a limit price with too many decimals', { limitPrice: 1.0822123 }],
    ['an end time in the past', { endTime: NOW - 1 }],
    ['an end time before the start', { endTime: NOW + 10 }],
    ['an unknown urgency', { urgency: 'URGENT' as never }],
    ['no actual change', { urgency: 'MEDIUM' as const }],
    ['no fields', {}],
  ])('rejects %s', (_name, changes) => {
    const base = record({ filledQty: 200_000, remainingQty: 800_000, startTime: NOW + 20 });
    expect(applyAmend(base, changes, NOW)).toMatchObject({ ok: false, code: 'INVALID_AMEND' });
  });

  it('does not mutate its input', () => {
    const base = record();
    const copy = structuredClone(base);
    applyAmend(base, { orderQty: 5_000_000 }, NOW);
    expect(base).toEqual(copy);
  });
});

describe('validateSubmission and recordFromSubmission', () => {
  const submission = (overrides: Partial<Omit<Order, 'orderId'>> = {}): Submission => {
    const { orderId: _id, ...order } = record().order;
    return { clientOrderId: 'c-1', order: { ...order, traderId: 'T1', account: 'T1-ACC-1', ...overrides } };
  };

  it('accepts a LIVE or PENDING_START order from a known trader and account', () => {
    expect(validateSubmission(submission()).ok).toBe(true);
    expect(validateSubmission(submission({ status: 'PENDING_START' })).ok).toBe(true);
  });

  it.each([
    ['a terminal status', { status: 'FILLED' as const }],
    ['a paused status', { status: 'PAUSED' as const }],
    ['a zero quantity', { orderQty: 0 }],
    ['an unknown trader', { traderId: 'T9' }],
    ['an account of another trader', { account: 'T2-ACC-1' }],
  ])('rejects %s', (_name, overrides) => {
    expect(validateSubmission(submission(overrides)).ok).toBe(false);
  });

  it('rejects input that is not a submission', () => {
    expect(validateSubmission(null).ok).toBe(false);
    expect(validateSubmission({ clientOrderId: '', order: {} }).ok).toBe(false);
  });

  it('builds the first record with v = 1, execSeq = 0 and the creation time', () => {
    const rec = recordFromSubmission(submission(), 'ALG00000042', NOW);
    expect(rec).toMatchObject({ v: 1, execSeq: 0, srcTs: NOW });
    expect(rec.order).toMatchObject({ orderId: 'ALG00000042', createdAt: NOW, lastUpdateTime: NOW });
  });
});

describe('checkAmend and canAmend', () => {
  const working = (over: Partial<Order> = {}): Order => record({ startTime: NOW - 60_000, endTime: NOW + 3_600_000, limitPrice: null, urgency: 'MEDIUM', filledQty: 100_000, remainingQty: 900_000, ...over }).order;

  it('says which statuses can be amended', () => {
    expect((['PENDING_START', 'LIVE', 'PAUSED'] as const).map(canAmend)).toEqual([true, true, true]);
    expect((['FILLED', 'CANCELLED'] as const).map(canAmend)).toEqual([false, false]);
  });

  it('returns null for an amend that may go ahead, and the failure otherwise, in the words applyAmend uses', () => {
    const order = working();
    expect(checkAmend(order, { urgency: 'HIGH' }, NOW)).toBeNull();
    expect(checkAmend(working({ status: 'FILLED' }), { urgency: 'HIGH' }, NOW)).toEqual({ code: 'INVALID_TRANSITION', message: 'Cannot amend an order that is FILLED' });
    expect(checkAmend(order, { orderQty: 100_000 }, NOW)).toEqual({ code: 'INVALID_AMEND', message: 'Quantity must be a whole number above the filled quantity (100000)' });
    expect(checkAmend(order, { orderQty: order.orderQty, urgency: order.urgency }, NOW)).toEqual({ code: 'INVALID_AMEND', message: 'Nothing to change' });
    expect(checkAmend(order, { endTime: NOW - 1 }, NOW)).toEqual({ code: 'INVALID_AMEND', message: 'End time must be after now and the start time' });
    expect(checkAmend(order, { limitPrice: 1.123456789 }, NOW)).toMatchObject({ code: 'INVALID_AMEND' });
  });

  it('agrees with applyAmend about every case', () => {
    const base = record({ startTime: NOW - 60_000, endTime: NOW + 3_600_000, filledQty: 100_000, remainingQty: 900_000 });
    for (const changes of [{ urgency: 'HIGH' }, { orderQty: 5 }, { endTime: 1 }, { limitPrice: 0.5 }, {}] as const) {
      const failure = checkAmend(base.order, changes, NOW);
      const applied = applyAmend(base, changes, NOW);
      expect(applied.ok).toBe(failure === null);
      if (!applied.ok) expect(failure).toEqual({ code: applied.code, message: applied.message });
    }
  });
});
