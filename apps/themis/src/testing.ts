import { sampleOrders, type Order } from '@apeiron/logos';

/** Finished orders (the first sample orders are historical). */
export function historyOrders(n: number): Order[] {
  return sampleOrders(n).map((o): Order => ({ ...o, status: 'FILLED' }));
}

/** LIVE orders with ids above the history ones, with nothing filled yet (so their `execSeq`, the number of fills, is 0). */
export function openOrders(n: number): Order[] {
  return sampleOrders(20 + n)
    .slice(20)
    .map(
      (o): Order => ({
        ...o,
        status: 'LIVE',
        completedAt: null,
        filledQty: 0,
        remainingQty: o.orderQty,
        pctComplete: 0,
        avgFillPrice: null,
        lastFillPrice: null,
        lastFillQty: 0,
        numFills: 0,
        numChildOrders: 0,
        filledNotionalUsd: 0,
        slippageBps: null,
        slippageUsd: 0,
        unrealisedPnlUsd: 0,
        realisedPnlUsd: 0,
      }),
    );
}
