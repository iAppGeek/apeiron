import { sampleOrders, type Order } from '@apeiron/logos';
import { ColumnarStore } from '../store/columnar-store.js';

const TEMPLATE = sampleOrders(1)[0] as Order;

/** Builds complete orders from partial overrides, with ascending ids `T0000001`, `T0000002`, ... */
export function makeOrders(overrides: readonly Partial<Order>[]): Order[] {
  return overrides.map(
    (o, i): Order => ({ ...TEMPLATE, orderId: `T${String(i + 1).padStart(7, '0')}`, ...o }),
  );
}

export function makeStore(overrides: readonly Partial<Order>[]): ColumnarStore {
  const store = new ColumnarStore({ capacity: Math.max(4, overrides.length) });
  store.appendBatch(makeOrders(overrides));
  return store;
}
