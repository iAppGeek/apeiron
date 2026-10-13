import { parseSubmission, type ExecReport, type OrderStateRecord, type Submission } from './contracts.js';
import {
  canTransition,
  deriveOverlay,
  distanceToLimitBpsOf,
  applyFill,
  pnlUsdOf,
  roundTo,
  type Overlay,
  type PriceQuote,
} from './lifecycle.js';
import { PAIR_BY_NAME, TRADER_SPECS, URGENCIES, type Order } from './order.js';
import type { AmendChanges } from './protocol.js';

/** The pure rules of the order service of record (PLAN1 Appendix 1C). They never touch I/O or the clock. */

const MIN_MS = 60_000;
const AMENDABLE = ['PENDING_START', 'LIVE', 'PAUSED'] as const;

export type ExecResult =
  /** The report changed the order: `v` is up by one. `clamped` is true when a fill was larger than what remained. */
  | { kind: 'applied'; record: OrderStateRecord; clamped: boolean }
  /** `execSeq` was not above the last accepted one: nothing changes. */
  | { kind: 'duplicate' }
  /** The report was well-formed but not allowed. The order is unchanged; `record.execSeq` advances so it is not replayed forever. */
  | { kind: 'rejected'; record: OrderStateRecord; message: string }
  /** The venue refused an instruction. The order is unchanged (only `execSeq` advances); the waiting command should hear `message`. */
  | { kind: 'venue_reject'; record: OrderStateRecord; instrId: string; message: string };

export type AmendResult =
  | { ok: true; record: OrderStateRecord }
  | { ok: false; code: 'INVALID_TRANSITION' | 'INVALID_AMEND'; message: string };

export type SubmissionCheck = { ok: true; submission: Submission } | { ok: false; message: string };

const isAmendable = (status: Order['status']): boolean => (AMENDABLE as readonly string[]).includes(status);

/** The next record after an accepted change: `v + 1`, `lastUpdateTime = ts`. */
function accept(record: OrderStateRecord, execSeq: number, ts: number, changes: Partial<Order>): OrderStateRecord {
  return { v: record.v + 1, execSeq, srcTs: ts, order: { ...record.order, ...changes, lastUpdateTime: ts } };
}

/** The market snapshot a terminal or filling report stores: the six overlay fields, taken from the report's quote. */
function snapshot(order: Order, quote: PriceQuote): Overlay {
  return deriveOverlay(order, quote);
}

function applyFillReport(record: OrderStateRecord, report: Extract<ExecReport, { type: 'FILL' }>): ExecResult {
  const { order } = record;
  const reject = (message: string): ExecResult => ({ kind: 'rejected', record: { ...record, execSeq: report.execSeq }, message });
  if (order.status !== 'LIVE') return reject(`Cannot fill an order that is ${order.status}`);
  if (!(report.price > 0) || !(report.qty > 0)) return reject('Fill needs a positive price and quantity');
  const fill = applyFill(order, report.qty, report.price, report.ts);
  if (Object.keys(fill).length === 0) return reject('Nothing remains to fill');
  const filled: Order = { ...order, ...fill };
  const overlay = snapshot(filled, report);
  const changes: Partial<Order> = { ...fill, ...overlay };
  if (filled.status === 'FILLED') {
    changes.unrealisedPnlUsd = 0;
    changes.realisedPnlUsd = pnlUsdOf(filled, overlay.marketMid);
  }
  const clamped = Math.round(report.qty) > order.remainingQty;
  return { kind: 'applied', record: accept(record, report.execSeq, report.ts, changes), clamped };
}

/**
 * Applies one execution report. `execSeq` must be above the record's, otherwise the report is a duplicate.
 * Fills larger than what remains are clamped. A completion carries the venue's quote, so the stored market
 * snapshot and the realised P&L come from the venue and not from any price feed.
 */
export function applyExecReport(record: OrderStateRecord, report: ExecReport): ExecResult {
  if (report.execSeq <= record.execSeq) return { kind: 'duplicate' };
  const { order } = record;
  const next = { ...record, execSeq: report.execSeq };
  const reject = (message: string): ExecResult => ({ kind: 'rejected', record: next, message });
  const applied = (changes: Partial<Order>): ExecResult => ({
    kind: 'applied',
    record: accept(record, report.execSeq, report.ts, changes),
    clamped: false,
  });
  switch (report.type) {
    case 'ACTIVATED':
      return order.status === 'PENDING_START' ? applied({ status: 'LIVE' }) : reject(`Cannot activate an order that is ${order.status}`);
    case 'FILL':
      return applyFillReport(record, report);
    case 'CANCELLED': {
      if (!canTransition(order.status, 'CANCELLED')) return reject(`Cannot cancel an order that is ${order.status}`);
      const overlay = snapshot(order, report);
      return applied({
        ...overlay,
        status: 'CANCELLED',
        completedAt: report.ts,
        realisedPnlUsd: pnlUsdOf(order, overlay.marketMid),
        unrealisedPnlUsd: 0,
      });
    }
    case 'PAUSED':
      return canTransition(order.status, 'PAUSED') ? applied({ status: 'PAUSED' }) : reject(`Cannot pause an order that is ${order.status}`);
    case 'RESUMED':
      return order.status === 'PAUSED'
        ? applied({ status: 'LIVE', endTime: order.endTime + Math.max(0, report.ts - order.lastUpdateTime) })
        : reject(`Cannot resume an order that is ${order.status}`);
    case 'VENUE_REJECT':
      return { kind: 'venue_reject', record: next, instrId: report.instrId, message: report.message };
  }
}

export type AmendFailure = { code: 'INVALID_TRANSITION' | 'INVALID_AMEND'; message: string };

/** Whether an order in this status can be amended (not yet FILLED or CANCELLED). */
export const canAmend = (status: Order['status']): boolean => isAmendable(status);

/** The fields an amend would change, with the quantity-derived ones recomputed. Empty when nothing would change. */
function amendedFields(order: Order, changes: AmendChanges): Partial<Order> {
  const { limitPrice, orderQty, endTime, urgency } = changes;
  const changed: Partial<Order> = {};
  if (limitPrice !== undefined && limitPrice !== order.limitPrice) {
    changed.limitPrice = limitPrice;
    changed.distanceToLimitBps = distanceToLimitBpsOf({ side: order.side, limitPrice }, order.marketMid);
  }
  if (orderQty !== undefined && orderQty !== order.orderQty) {
    const notionalUsd = roundTo((order.notionalUsd / order.orderQty) * orderQty, 2);
    changed.orderQty = orderQty;
    changed.remainingQty = orderQty - order.filledQty;
    changed.pctComplete = roundTo((order.filledQty / orderQty) * 100, 2);
    changed.notionalUsd = notionalUsd;
    changed.filledNotionalUsd = roundTo((notionalUsd * order.filledQty) / orderQty, 2);
  }
  if (endTime !== undefined && endTime !== order.endTime) {
    changed.endTime = endTime;
    changed.durationMins = Math.max(1, Math.round((endTime - order.startTime) / MIN_MS));
  }
  if (urgency !== undefined && urgency !== order.urgency) changed.urgency = urgency;
  return changed;
}

/**
 * The first rule an amend of `order` breaks, or null when it may go ahead. The order service applies it; a client may run
 * the same check to warn before sending (for the user's convenience only: the service decides).
 */
export function checkAmend(order: Order, changes: AmendChanges, now: number): AmendFailure | null {
  const invalid = (message: string): AmendFailure => ({ code: 'INVALID_AMEND', message });
  if (!isAmendable(order.status)) return { code: 'INVALID_TRANSITION', message: `Cannot amend an order that is ${order.status}` };
  const { limitPrice, orderQty, endTime, urgency } = changes;
  if (orderQty !== undefined && (!Number.isInteger(orderQty) || orderQty <= order.filledQty)) {
    return invalid(`Quantity must be a whole number above the filled quantity (${order.filledQty})`);
  }
  if (limitPrice !== undefined && limitPrice !== null) {
    const decimals = PAIR_BY_NAME.get(order.currencyPair)?.decimals ?? 5;
    if (!(limitPrice > 0) || roundTo(limitPrice, decimals) !== limitPrice) {
      return invalid(`Limit price must be positive with at most ${decimals} decimals`);
    }
  }
  if (endTime !== undefined && !(endTime > Math.max(now, order.startTime))) return invalid('End time must be after now and the start time');
  if (urgency !== undefined && !URGENCIES.includes(urgency)) return invalid(`Unknown urgency ${String(urgency)}`);
  if (Object.keys(amendedFields(order, changes)).length === 0) return invalid('Nothing to change');
  return null;
}

/**
 * Validates and applies an amend of `limitPrice`, `orderQty`, `endTime` and `urgency`. Recomputes the
 * quantity-derived fields (`remainingQty`, `pctComplete`, `notionalUsd` at the same USD rate per unit,
 * `filledNotionalUsd`), `durationMins` and `distanceToLimitBps`.
 */
export function applyAmend(record: OrderStateRecord, changes: AmendChanges, now: number): AmendResult {
  const failure = checkAmend(record.order, changes, now);
  if (failure !== null) return { ok: false, ...failure };
  return { ok: true, record: accept(record, record.execSeq, now, amendedFields(record.order, changes)) };
}

/**
 * Checks a submission: schema-valid, `LIVE` or `PENDING_START`, a positive quantity, and a known trader and
 * account. Duplicate `clientOrderId` detection needs state, so the order service does it.
 */
export function validateSubmission(input: unknown): SubmissionCheck {
  const parsed = parseSubmission(input);
  if (!parsed.ok) return { ok: false, message: parsed.error };
  const { order } = parsed.value;
  if (order.status !== 'LIVE' && order.status !== 'PENDING_START') return { ok: false, message: `A new order cannot be ${order.status}` };
  if (!(order.orderQty > 0)) return { ok: false, message: 'Quantity must be positive' };
  const trader = TRADER_SPECS.find((t) => t.traderId === order.traderId);
  if (trader === undefined) return { ok: false, message: `Unknown trader ${order.traderId}` };
  if (!trader.accounts.includes(order.account)) return { ok: false, message: `Unknown account ${order.account} for ${order.traderId}` };
  return { ok: true, submission: parsed.value };
}

/** The first record of an accepted submission: `v = 1`, `execSeq = 0`, `createdAt = lastUpdateTime = ts`. */
export function recordFromSubmission(submission: Submission, orderId: string, ts: number): OrderStateRecord {
  return { v: 1, execSeq: 0, srcTs: ts, order: { ...submission.order, orderId, createdAt: ts, lastUpdateTime: ts } };
}
