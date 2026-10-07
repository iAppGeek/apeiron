import { PAIR_BY_NAME, type Order, type OrderStatus, type Side } from './order.js';

const roundTo = (value: number, decimals: number): number => {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
};

const decimalsOf = (order: Pick<Order, 'currencyPair'>): number => PAIR_BY_NAME.get(order.currencyPair)?.decimals ?? 5;

/** +1 for BUY, -1 for SELL. */
export const sideSign = (side: Side): 1 | -1 => (side === 'BUY' ? 1 : -1);

/** The orders a trader can still act on. */
export const isOpen = (status: OrderStatus): boolean => status === 'LIVE' || status === 'PAUSED';

/** Orders that never change again. */
export const isTerminal = (status: OrderStatus): boolean => status === 'FILLED' || status === 'CANCELLED';

/** Slippage in bps, positive when adverse: `side * (avgFill - arrival) / arrival`. */
export function slippageBpsOf(order: Pick<Order, 'side' | 'arrivalPrice'>, avgFillPrice: number): number {
  return roundTo((sideSign(order.side) * (avgFillPrice - order.arrivalPrice) * 1e4) / order.arrivalPrice, 2);
}

/** Unrealised P&L in USD at `mid`: `filledQty * side * (mid - avgFill)`, converted through the order's own USD rate. */
export function pnlUsdOf(
  order: Pick<Order, 'side' | 'filledQty' | 'avgFillPrice' | 'notionalUsd' | 'orderQty'>,
  mid: number,
): number {
  if (order.avgFillPrice === null || order.filledQty <= 0 || mid <= 0) return 0;
  const baseUsd = order.notionalUsd / order.orderQty;
  return roundTo((order.filledQty * sideSign(order.side) * (mid - order.avgFillPrice) * baseUsd) / mid, 2);
}

/**
 * The absolute post-fill values of an order that receives a fill of `fillQty` at `fillPrice`. Only LIVE
 * orders fill; any other status (and a non-positive quantity) returns no changes. The quantity is clamped
 * to what remains. `avgFillPrice` is the VWAP of all fills. When the order completes, `status`,
 * `completedAt` and the realised P&L (at the order's current `marketMid`) are included.
 */
export function applyFill(order: Order, fillQty: number, fillPrice: number, now: number): Partial<Order> {
  if (order.status !== 'LIVE') return {};
  const qty = Math.min(Math.round(fillQty), order.remainingQty);
  if (qty <= 0) return {};
  const dec = decimalsOf(order);
  const filledQty = order.filledQty + qty;
  const remainingQty = order.orderQty - filledQty;
  const priorNotional = (order.avgFillPrice ?? 0) * order.filledQty;
  const avgFillPrice = roundTo((priorNotional + fillPrice * qty) / filledQty, dec);
  const filledNotionalUsd = roundTo((order.notionalUsd * filledQty) / order.orderQty, 2);
  const slippageBps = slippageBpsOf(order, avgFillPrice);
  const changes: Partial<Order> = {
    filledQty,
    remainingQty,
    pctComplete: roundTo((filledQty / order.orderQty) * 100, 2),
    avgFillPrice,
    lastFillPrice: fillPrice,
    lastFillQty: qty,
    numFills: order.numFills + 1,
    numChildOrders: order.numChildOrders + 1,
    filledNotionalUsd,
    slippageBps,
    slippageUsd: roundTo((slippageBps / 1e4) * filledNotionalUsd, 2),
    lastUpdateTime: now,
  };
  if (remainingQty === 0) {
    changes.status = 'FILLED';
    changes.completedAt = now;
    changes.unrealisedPnlUsd = 0;
    changes.realisedPnlUsd = pnlUsdOf({ ...order, filledQty, avgFillPrice }, order.marketMid);
  }
  return changes;
}

const ALLOWED: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  PENDING_START: ['LIVE', 'CANCELLED'],
  LIVE: ['PAUSED', 'FILLED', 'CANCELLED'],
  PAUSED: ['LIVE', 'CANCELLED'],
  FILLED: [],
  CANCELLED: [],
};

export type TransitionResult =
  | { ok: true; changes: Partial<Order> }
  | { ok: false; code: 'INVALID_TRANSITION'; message: string };

/**
 * Validates a status change against the lifecycle state machine (Appendix E) and returns the absolute
 * changed fields. PENDING_START to LIVE or CANCELLED; LIVE to PAUSED, FILLED (only when nothing remains) or
 * CANCELLED; PAUSED to LIVE or CANCELLED. FILLED and CANCELLED are final. Terminal transitions set
 * `completedAt` and move the open P&L into `realisedPnlUsd`.
 */
export function transition(order: Order, to: OrderStatus, now: number): TransitionResult {
  const from = order.status;
  if (!ALLOWED[from].includes(to)) {
    return { ok: false, code: 'INVALID_TRANSITION', message: `Cannot go from ${from} to ${to}` };
  }
  if (to === 'FILLED' && order.remainingQty > 0) {
    return { ok: false, code: 'INVALID_TRANSITION', message: 'Cannot fill an order with quantity remaining' };
  }
  const changes: Partial<Order> = { status: to, lastUpdateTime: now };
  if (isTerminal(to)) {
    changes.completedAt = now;
    changes.realisedPnlUsd = isOpen(from) ? order.unrealisedPnlUsd : order.realisedPnlUsd;
    changes.unrealisedPnlUsd = 0;
  }
  return { ok: true, changes };
}

export type PriceQuote = { bid: number; ask: number };

/** The fields {@link derivePriceFields} reads, so the server can pass a light object instead of a full order. */
export type PriceDerivationInput = Pick<
  Order,
  | 'currencyPair'
  | 'side'
  | 'status'
  | 'limitPrice'
  | 'avgFillPrice'
  | 'arrivalPrice'
  | 'filledQty'
  | 'orderQty'
  | 'notionalUsd'
>;

/**
 * The price-derived fields the server owns, recomputed from the latest quote: `marketBid/Ask/Mid`,
 * `spreadBps`, `distanceToLimitBps` (positive when the market is inside the limit, by side),
 * `slippageBps` when the order has fills, `unrealisedPnlUsd` for LIVE and PAUSED orders, and
 * `lastUpdateTime`.
 */
export function derivePriceFields(order: PriceDerivationInput, quote: PriceQuote, now: number): Partial<Order> {
  const dec = decimalsOf(order);
  const marketBid = roundTo(quote.bid, dec);
  const marketAsk = roundTo(quote.ask, dec);
  const marketMid = roundTo((quote.bid + quote.ask) / 2, dec);
  const changes: Partial<Order> = {
    marketBid,
    marketAsk,
    marketMid,
    spreadBps: roundTo(((marketAsk - marketBid) / marketMid) * 1e4, 2),
    distanceToLimitBps:
      order.limitPrice === null
        ? null
        : roundTo((sideSign(order.side) * (order.limitPrice - marketMid) * 1e4) / marketMid, 2),
    lastUpdateTime: now,
  };
  if (order.avgFillPrice !== null) changes.slippageBps = slippageBpsOf(order, order.avgFillPrice);
  if (isOpen(order.status)) changes.unrealisedPnlUsd = pnlUsdOf(order, marketMid);
  return changes;
}
