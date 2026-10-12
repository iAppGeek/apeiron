import { BUCKETS, PROJECTION_KEY, type MemoryBus, type Order, type OrderStateRecord } from '@apeiron/logos';

/** The record the order service publishes for an order at version `v`. */
export const recordOf = (order: Order, v = 1): OrderStateRecord => ({ v, execSeq: order.numFills, srcTs: order.lastUpdateTime, order });

const CONFIG = { history: 1, storage: 'memory' } as const;

/** Creates the two buckets on a bus the way the order service does, without writing anything. */
export async function ensureBuckets(bus: MemoryBus): Promise<void> {
  await bus.kv(BUCKETS.orderState).ensure(CONFIG);
  await bus.kv(BUCKETS.orderStateMeta).ensure(CONFIG);
}

/** Writes the projection marker. */
export async function markProjection(bus: MemoryBus, count: number, ready = true): Promise<void> {
  await bus.kv(BUCKETS.orderStateMeta).put(PROJECTION_KEY, { ready, count, epoch: 'test', builtAt: 1 });
}

/** Publishes one order's record. */
export async function publishRecord(bus: MemoryBus, order: Order, v = 1): Promise<void> {
  await bus.kv(BUCKETS.orderState).put(order.orderId, recordOf(order, v));
}

/**
 * What a running order service leaves behind: both buckets, one record per order at version 1 (in the given order,
 * which need not be ascending) and a ready marker.
 */
export async function seedBucket(bus: MemoryBus, orders: readonly Order[]): Promise<void> {
  await ensureBuckets(bus);
  for (const order of orders) await publishRecord(bus, order);
  await markProjection(bus, orders.length);
}
