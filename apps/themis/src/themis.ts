import {
  BUCKETS,
  CONSUMERS,
  STREAMS,
  SUBJECTS,
  isTerminal,
  parseOrderEvent,
  parseOrderStateRecord,
  type Bus,
  type BusSubscription,
  type KvBucket,
} from '@apeiron/logos';
import type { OrderRepository, StoredOrder } from '@apeiron/mnemosyne';
import { applyOrderEvent } from './apply-event.js';
import { GroupCommitter } from './committer.js';
import type { Logger } from './log.js';
import type { ThemisMetrics } from './metrics.js';
import { ensureProjection, reconcileProjection } from './projection.js';

export type ThemisOptions = {
  bus: Bus;
  repo: OrderRepository;
  log: Logger;
  groupCommitMs: number;
  groupCommitMax: number;
  reconcileWindowMin: number;
  rebuildProjection: boolean;
  metrics?: ThemisMetrics;
  now?: () => number;
};

export type ThemisStatus = { status: 'ok' | 'stopped'; openOrders: number; applied: number; commits: number };

export type Themis = {
  status(): ThemisStatus;
  debug(): Record<string, unknown>;
  /** Commits everything queued and waits for it. */
  flush(): Promise<void>;
  /** Stops consuming. `flush: false` abandons whatever is not yet committed, as a crash would. */
  stop(options?: { flush?: boolean }): Promise<void>;
};

/** `ORDER_STATE`: one key per order, last value only. */
export const ORDER_STATE_CONFIG = { history: 1, storage: 'file', replicas: 1, maxValueSize: 16 * 1024, maxBytes: 4 * 1024 ** 3 } as const;
export const ORDER_STATE_META_CONFIG = { history: 1, storage: 'file', replicas: 1 } as const;

const isOpenRecord = (stored: StoredOrder): boolean => !isTerminal(stored.order.status);

/**
 * The order service of record, in projection mode (phase 1.2). It owns the database: it reads today's
 * `orders.events` through its own durable consumer, applies them to the full order, stores each batch (group
 * commit) and only then publishes the new version to the `ORDER_STATE` bucket and acknowledges the input.
 * Startup makes sure the bucket holds every order, reconciles anything a crash left unpublished, and loads the
 * open orders into memory. Events are handled one at a time, so an order's versions are strictly ordered.
 */
export async function startThemis(options: ThemisOptions): Promise<Themis> {
  const { bus, repo, log, metrics } = options;
  const state = bus.kv(BUCKETS.orderState);
  const meta = bus.kv(BUCKETS.orderStateMeta);
  await state.ensure({ history: 1, storage: 'file', replicas: 1, maxValueSize: ORDER_STATE_CONFIG.maxValueSize, maxBytes: ORDER_STATE_CONFIG.maxBytes });
  await meta.ensure({ history: 1, storage: 'file', replicas: 1 });

  const deps = { repo, state, meta, log, ...(options.now === undefined ? {} : { now: options.now }) };
  const rebuilt = await ensureProjection(deps, options.rebuildProjection);
  if (rebuilt !== null) metrics?.projectionRebuilt(rebuilt.seconds);
  else await reconcileProjection(deps, options.reconcileWindowMin * 60_000);

  /** Open orders, plus terminal ones whose last version is still being committed. */
  const book = new Map<string, StoredOrder>();
  for (const stored of await repo.loadOpen()) book.set(stored.order.orderId, stored);
  log.info({ open: book.size }, 'loaded open orders');

  const committer = new GroupCommitter({
    repo,
    state,
    log,
    windowMs: options.groupCommitMs,
    maxBatch: options.groupCommitMax,
    ...(metrics === undefined ? {} : { metrics }),
  });
  let applied = 0;
  let stopped = false;

  const openOrders = (): number => {
    let n = 0;
    for (const stored of book.values()) if (isOpenRecord(stored)) n++;
    return n;
  };
  metrics?.bind(() => ({ openOrders: openOrders() }));

  const lookup = async (orderId: string, kv: KvBucket): Promise<StoredOrder | undefined> => {
    const held = book.get(orderId);
    if (held !== undefined) return held;
    const entry = await kv.get(orderId);
    if (entry === null) return undefined;
    const parsed = parseOrderStateRecord(entry.value);
    return parsed.ok ? { order: parsed.value.order, v: parsed.value.v, execSeq: parsed.value.execSeq } : undefined;
  };

  const handle = async (payload: unknown, ack: () => void): Promise<void> => {
    const parsed = parseOrderEvent(payload);
    if (!parsed.ok) {
      log.warn({ error: parsed.error }, 'dropped invalid order event');
      metrics?.event('invalid', 'invalid');
      committer.whenCommitted(ack);
      return;
    }
    const event = parsed.value;
    const current = event.type === 'REJECT' ? undefined : await lookup(event.order.orderId, state);
    const outcome = applyOrderEvent(current, event);
    if (outcome.kind !== 'changed') {
      metrics?.event(event.type, outcome.kind);
      committer.whenCommitted(ack);
      return;
    }
    const { record, srcTs } = outcome;
    book.set(record.order.orderId, record);
    applied++;
    metrics?.event(event.type, 'applied');
    committer.submit(record, srcTs, () => {
      // Forget a finished order only if nothing newer has been applied since.
      if (!isOpenRecord(record) && book.get(record.order.orderId)?.v === record.v) book.delete(record.order.orderId);
      ack();
    });
  };

  let chain: Promise<void> = Promise.resolve();
  let consumer: BusSubscription | null = null;
  consumer = await bus.consume(
    { stream: STREAMS.orders, durable: CONSUMERS.themis, subject: SUBJECTS.ordersEvents },
    (payload, _subject, ack) => {
      chain = chain.then(() => handle(payload, ack)).catch((error: unknown) => {
        log.error({ err: error }, 'failed to handle an order event');
      });
    },
  );
  log.info({ stream: STREAMS.orders, durable: CONSUMERS.themis }, 'consuming order events');

  return {
    status: (): ThemisStatus => ({ status: stopped ? 'stopped' : 'ok', openOrders: openOrders(), applied, commits: committer.stats.batches }),
    debug: (): Record<string, unknown> => ({
      openOrders: openOrders(),
      heldOrders: book.size,
      pendingInstructions: 0,
      queued: committer.pending,
      lastCommit: { size: committer.stats.lastSize, ms: committer.stats.lastMs, kvMs: committer.stats.lastKvMs },
      commits: committer.stats.batches,
    }),
    flush: async (): Promise<void> => {
      await chain;
      await committer.flush();
    },
    stop: async (stopOptions: { flush?: boolean } = {}): Promise<void> => {
      stopped = true;
      await consumer?.close();
      if (stopOptions.flush === false) return;
      await chain;
      await committer.stop();
    },
  };
}
