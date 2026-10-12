import { PAIRS, type CurrencyPair, type Order } from '@apeiron/logos';

/**
 * An order with the two counters its owner (themis) keeps beside the 50 fields. `v`: the per-order version, 1 at
 * creation and +1 per accepted change. `execSeq`: the last execution report accepted. A stored document that
 * has neither reads as `v = 1` and `execSeq = numFills`.
 */
export type StoredOrder = { order: Order; v: number; execSeq: number };

/** Wraps an order that has no history yet: `v = 1`, `execSeq = numFills`. */
export const toStoredOrder = (order: Order): StoredOrder => ({ order, v: 1, execSeq: order.numFills });

/**
 * Each pair's latest `marketMid` among `orders`: the most recently updated order wins, the larger `orderId`
 * breaks a tie, and a pair with no orders gets its reference level.
 */
export function latestMidsOf(orders: Iterable<Order>): Record<CurrencyPair, number> {
  const latest = new Map<CurrencyPair, Order>();
  for (const order of orders) {
    const seen = latest.get(order.currencyPair);
    if (
      seen === undefined ||
      order.lastUpdateTime > seen.lastUpdateTime ||
      (order.lastUpdateTime === seen.lastUpdateTime && order.orderId > seen.orderId)
    ) {
      latest.set(order.currencyPair, order);
    }
  }
  return Object.fromEntries(PAIRS.map((p): [CurrencyPair, number] => [p.pair, latest.get(p.pair)?.marketMid ?? p.mid])) as Record<
    CurrencyPair,
    number
  >;
}

/**
 * Storage port for orders. Implemented by Mongo (full adapter) and in-memory (fake); Oracle and KDB
 * adapters are expected to satisfy the same contract suite (`repository.contract.ts`).
 */
export type OrderRepository = {
  /**
   * Streams every order in ascending `orderId` order, in batches of at most `batchSize`
   * (default {@link DEFAULT_BATCH_SIZE}). Implementations must not materialise the full set.
   */
  loadAll(batchSize?: number): AsyncIterable<StoredOrder[]>;
  /** Inserts or fully replaces orders (with their `v` and `execSeq`) by `orderId`. Idempotent. An empty list is a no-op. */
  upsertMany(records: readonly StoredOrder[]): Promise<void>;
  /** Exact number of stored orders. */
  count(): Promise<number>;
  /** True when at least one order is stored. */
  isSeeded(): Promise<boolean>;
  /** The orders that can still change: PENDING_START, LIVE and PAUSED, ascending by `orderId`. */
  loadOpen(): Promise<StoredOrder[]>;
  /**
   * Streams the orders whose `lastUpdateTime` is at or after `ts`, ascending by `orderId`, in batches of at
   * most `batchSize`. The order service uses it to find work a crash left unpublished.
   */
  loadUpdatedSince(ts: number, batchSize?: number): AsyncIterable<StoredOrder[]>;
  /** The latest `marketMid` per pair among open orders (see {@link latestMidsOf}). */
  latestMidsByPair(): Promise<Record<CurrencyPair, number>>;
  /** The highest stored `orderId`, or null when empty, so new ids can stay ascending. */
  maxOrderId(): Promise<string | null>;
  /** Removes every stored order. Idempotent on an empty repository. */
  clear(): Promise<void>;
};

export const DEFAULT_BATCH_SIZE = 10_000;
