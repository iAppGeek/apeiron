import { generateOrders, type Order } from '@apeiron/logos';

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
