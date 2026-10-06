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
  /**
   * The orders that can still change: PENDING_START, LIVE and PAUSED, ascending by `orderId`. Hermes uses
   * it to rebuild its state at startup.
   */
  loadCurrent(): Promise<Order[]>;
  /** The highest stored `orderId`, or null when empty, so new ids can stay ascending. */
  maxOrderId(): Promise<string | null>;
  /** Removes every stored order. Idempotent on an empty repository. */
  clear(): Promise<void>;
};

export const DEFAULT_BATCH_SIZE = 10_000;
