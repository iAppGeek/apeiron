import type { KvBucket, OrderStateRecord } from '@apeiron/logos';
import type { OrderRepository, StoredOrder } from '@apeiron/mnemosyne';

export type CommitterLogger = { warn(fields: Record<string, unknown>, msg: string): void };

export type CommitterMetrics = {
  commit(info: { batchSize: number; seconds: number }): void;
  kvPut(seconds: number): void;
};

export type CommitterOptions = {
  repo: OrderRepository;
  /** The `ORDER_STATE` bucket. */
  state: KvBucket;
  log: CommitterLogger;
  /** A batch waits at most this long for more changes. */
  windowMs: number;
  /** ...or until this many are waiting. */
  maxBatch: number;
  metrics?: CommitterMetrics;
  /** First retry delay after a failed write; doubles up to {@link MAX_BACKOFF_MS}. */
  backoffMs?: number;
};

export const MAX_BACKOFF_MS = 5_000;

type Change = { record: StoredOrder; srcTs: number; done: (() => void) | null };
/** A marker: `done` runs once everything queued before it is committed. */
type Item = Change | { record: null; done: () => void };

export type CommitStats = { batches: number; changes: number; lastSize: number; lastMs: number; lastKvMs: number };

/** The KV value for a stored order. */
export const toStateRecord = ({ order, v, execSeq }: StoredOrder, srcTs: number): OrderStateRecord => ({ v, execSeq, srcTs, order });

/**
 * Persist-then-publish. Changes queue up and are committed in batches (a window of `windowMs`, or `maxBatch`
 * changes): the batch is written to the database and awaited, then its KV puts are issued in order and awaited,
 * then each change's `done` runs, in order. A failed write is retried with backoff until it succeeds, so nothing
 * is dropped and nothing is published before it is stored. Within a batch, several changes to one order collapse
 * to the latest, keeping the position of the first so new ids stay in ascending order. Batches never overlap.
 */
export class GroupCommitter {
  readonly stats: CommitStats = { batches: 0, changes: 0, lastSize: 0, lastMs: 0, lastKvMs: 0 };
  private queue: Item[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private draining: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly options: CommitterOptions) {}

  get pending(): number {
    return this.queue.length;
  }

  /** Queues a change; `done` runs once it is stored and published. */
  submit(record: StoredOrder, srcTs: number, done: (() => void) | null = null): void {
    this.queue.push({ record, srcTs, done });
    this.kick();
  }

  /** Runs `done` after everything queued so far is committed (at once when nothing is waiting). */
  whenCommitted(done: () => void): void {
    if (this.queue.length === 0 && this.draining === null) {
      done();
      return;
    }
    this.queue.push({ record: null, done });
    this.kick();
  }

  /** Commits everything queued and resolves when it is done. */
  async flush(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    while (this.queue.length > 0 || this.draining !== null) {
      this.draining ??= this.drain();
      await this.draining;
    }
  }

  async stop(): Promise<void> {
    await this.flush();
    this.stopped = true;
  }

  private kick(): void {
    if (this.draining !== null) return;
    if (this.queue.length >= this.options.maxBatch) {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      this.draining = this.drain();
      return;
    }
    this.timer ??= setTimeout(() => {
      this.timer = null;
      if (this.draining === null && this.queue.length > 0) this.draining = this.drain();
    }, this.options.windowMs);
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.options.maxBatch);
        await this.commit(batch);
      }
    } finally {
      this.draining = null;
      if (this.queue.length > 0) this.kick();
    }
  }

  private async commit(batch: Item[]): Promise<void> {
    const latest = new Map<string, Change>();
    for (const item of batch) {
      if (item.record !== null) latest.set(item.record.order.orderId, item);
    }
    const changes = [...latest.values()];
    const start = performance.now();
    if (changes.length > 0) {
      await this.retry('database write', () => this.options.repo.upsertMany(changes.map((c) => c.record)));
      const kvStart = performance.now();
      await this.retry('KV publish', async () => {
        await Promise.all(changes.map((c) => this.options.state.put(c.record.order.orderId, toStateRecord(c.record, c.srcTs))));
      });
      const kvMs = performance.now() - kvStart;
      this.stats.lastKvMs = kvMs;
      this.options.metrics?.kvPut(kvMs / 1000);
    }
    for (const item of batch) item.done?.();
    const ms = performance.now() - start;
    this.stats.batches++;
    this.stats.changes += changes.length;
    this.stats.lastSize = changes.length;
    this.stats.lastMs = ms;
    if (changes.length > 0) this.options.metrics?.commit({ batchSize: changes.length, seconds: ms / 1000 });
  }

  private async retry(what: string, run: () => Promise<void>): Promise<void> {
    let delay = this.options.backoffMs ?? 100;
    for (let attempt = 1; ; attempt++) {
      try {
        await run();
        return;
      } catch (error) {
        this.options.log.warn({ err: error, attempt, delayMs: delay }, `${what} failed, retrying`);
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
      }
    }
  }
}

