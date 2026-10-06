import {
  COLUMNS,
  ORDER_STATUSES,
  generateOrderBatches,
  generateOrders,
  mulberry32,
  type Order,
  type OrderField,
} from '@apeiron/logos';
import { ColumnarStore } from '../store/columnar-store.js';

/** A fixed "now" so generated data is reproducible. */
export const FIXED_NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

/** Streams real generator data (the same distributions as the seeded DB) into a store, in 10k batches. */
export function generateStore(n: number, seed = 42, capacity?: number): ColumnarStore {
  const store = new ColumnarStore({ capacity: capacity ?? Math.max(1_500_000, Math.ceil(n * 1.5)) });
  for (const batch of generateOrderBatches({ seed, n, now: FIXED_NOW, batchSize: 10_000 })) store.appendBatch(batch);
  return store;
}

/** Loads orders into a store. */
export function storeFrom(orders: readonly Order[], capacity?: number): ColumnarStore {
  const store = new ColumnarStore({ capacity });
  for (let i = 0; i < orders.length; i += 10_000) store.appendBatch(orders.slice(i, i + 10_000));
  return store;
}

const NULLABLE_FIELDS: readonly OrderField[] = COLUMNS.filter((c) => c.nullable === true).map(
  (c): OrderField => c.field,
);

/**
 * Real generator data, lightly mutated for property tests: some rows get a random status (the real
 * data is 99.9% FILLED/CANCELLED), some nullable fields are nulled (plus a few null value dates), and -0
 * becomes 0. Seeded, so
 * the same arguments always give the same rows.
 */
export function propertyOrders(seed: number, n: number): Order[] {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const out: Order[] = [];
  for (const order of generateOrders(seed, n, FIXED_NOW)) {
    const o: Record<string, unknown> = { ...order };
    for (const [k, v] of Object.entries(o)) if (v === 0) o[k] = 0;
    if (rng() < 0.15) o.status = ORDER_STATUSES[Math.floor(rng() * ORDER_STATUSES.length)];
    for (const f of NULLABLE_FIELDS) if (rng() < 0.08) o[f] = null;
    // Beyond the schema on purpose: exercises the "(blank)" group key and date-filter null handling.
    if (rng() < 0.03) o.valueDate = null;
    out.push(o as Order);
  }
  return out;
}
