import { generateOrders, type Order } from '@apeiron/logos';

/** The seed time the test data is anchored to. */
export const SEED_NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

let cached: Order[] | null = null;

/** The 40 LIVE and 20 PENDING_START orders of a deterministic 100k-row dataset. */
export function currentOrders(): Order[] {
  if (cached === null) {
    const all: Order[] = [];
    for (const o of generateOrders(42, 100_000, SEED_NOW)) {
      if (o.status === 'LIVE' || o.status === 'PENDING_START') all.push(o);
    }
    cached = all;
  }
  return cached.map((o) => structuredClone(o));
}
