import { sampleOrders, type Order } from '@apeiron/logos';

/** Finished orders (the first sample orders are historical). */
export function historyOrders(n: number): Order[] {
  return sampleOrders(n).map((o): Order => ({ ...o, status: 'FILLED' }));
}

/** LIVE orders with ids above the history ones. */
export function openOrders(n: number): Order[] {
  return sampleOrders(20 + n)
    .slice(20)
    .map((o): Order => ({ ...o, status: 'LIVE', completedAt: null }));
}
