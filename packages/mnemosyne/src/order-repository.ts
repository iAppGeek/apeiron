import type { Order } from '@apeiron/logos';

/**
 * Storage port for orders. Implemented by Mongo (full adapter) and in-memory (fake); Oracle and KDB
 * adapters are expected to satisfy the same contract suite (`repository.contract.ts`).
 */
export type OrderRepository = {
  /**
   * Streams every order in ascending `orderId` order, in batches of at most `batchSize`
   * (default {@link DEFAULT_BATCH_SIZE}). Implementations must not materialise the full set.
   */
  loadAll(batchSize?: number): AsyncIterable<Order[]>;
  /** Inserts or fully replaces orders by `orderId`. Idempotent. An empty list is a no-op. */
  upsertMany(orders: readonly Order[]): Promise<void>;
  /** Exact number of stored orders. */
  count(): Promise<number>;
  /** True when at least one order is stored. */
  isSeeded(): Promise<boolean>;
  /** Removes every stored order. Idempotent on an empty repository. */
  clear(): Promise<void>;
};

export const DEFAULT_BATCH_SIZE = 10_000;
