import { PAIRS, generateOrders, type Order, type PriceTick } from '@apeiron/logos';
import { QuoteBook } from './quotes.js';

/** The seed time the test data is anchored to. */
export const SEED_NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

let cached: Order[] | null = null;

/** The 20 LIVE and 10 PENDING_START orders of a deterministic 50k-row dataset (cheap enough for CI). */
export function currentOrders(): Order[] {
  if (cached === null) {
    const all: Order[] = [];
    for (const o of generateOrders(42, 50_000, SEED_NOW)) {
      if (o.status === 'LIVE' || o.status === 'PENDING_START') all.push(o);
    }
    cached = all;
  }
  return cached.map((o) => structuredClone(o));
}

/**
 * The market the lifecycle simulator prices against in tests: each pair at the `marketMid` of the most recently
 * updated order of that pair (ties: higher `orderId`), else its reference level, with a tight spread.
 */
export function quotesFor(orders: readonly Order[], ts = SEED_NOW): PriceTick[] {
  const latest = new Map<string, Order>();
  for (const order of orders) {
    const seen = latest.get(order.currencyPair);
    if (seen === undefined || order.lastUpdateTime > seen.lastUpdateTime || (order.lastUpdateTime === seen.lastUpdateTime && order.orderId > seen.orderId)) {
      latest.set(order.currencyPair, order);
    }
  }
  return PAIRS.map((p): PriceTick => {
    const mid = latest.get(p.pair)?.marketMid ?? p.mid;
    const half = (mid * 0.5e-4) / 1;
    const unit = 10 ** -p.decimals;
    const round = (x: number): number => Number(x.toFixed(p.decimals));
    const bid = round(Math.round((mid - half) / unit) * unit);
    const ask = round(Math.max(Math.round((mid + half) / unit) * unit, bid + unit));
    return { pair: p.pair, bid, ask, ts };
  });
}

/** A {@link QuoteBook} holding {@link quotesFor}. */
export function quoteBookFor(orders: readonly Order[], ts = SEED_NOW): QuoteBook {
  const book = new QuoteBook();
  for (const tick of quotesFor(orders, ts)) book.update(tick);
  return book;
}
