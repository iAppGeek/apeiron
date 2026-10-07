import type { OrderRepository } from '@apeiron/mnemosyne';
import type { RuntimeMetrics } from '../metrics.js';
import type { LiveStore } from './live-store.js';

export type WriteBehindLogger = {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
};

export type WriteBehindStats = { passes: number; ordersWritten: number; failures: number; lastMs: number };

/**
 * Persists the rows that lifecycle events changed, in batches. Each pass takes what is dirty, rebuilds the
 * full `Order` from the store and upserts it; only after the write succeeds is the bus acknowledged, so a
 * crash replays (idempotently) exactly the events that were not yet persisted. Price-only changes are never
 * dirty. Passes never overlap.
 */
export class WriteBehind {
  readonly stats: WriteBehindStats = { passes: 0, ordersWritten: 0, failures: 0, lastMs: 0 };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> = Promise.resolve();
  private stopped = true;

  constructor(
    private readonly live: LiveStore,
    private readonly repo: OrderRepository,
    private readonly log: WriteBehindLogger,
    private readonly intervalMs: number,
    private readonly metrics?: Pick<RuntimeMetrics, 'writeBehind'>,
  ) {}

  start(): void {
    this.stopped = false;
    this.schedule();
  }

  /** Runs one pass now (after any pass already running). */
  flush(): Promise<void> {
    this.running = this.running.then(() => this.pass());
    return this.running;
  }

  /** Stops the timer and writes whatever is still dirty. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.flush();
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.flush().finally(() => this.schedule());
    }, this.intervalMs);
  }

  private async pass(): Promise<void> {
    const batch = this.live.takeWriteBatch();
    if (batch.orders.length === 0) {
      batch.ack?.();
      return;
    }
    const start = performance.now();
    try {
      await this.repo.upsertMany(batch.orders);
    } catch (error) {
      this.stats.failures++;
      this.metrics?.writeBehind({ batchSize: batch.orders.length, seconds: (performance.now() - start) / 1000, ok: false });
      this.log.error({ err: error, orders: batch.orders.length }, 'write-behind failed, will retry');
      this.live.restoreWriteBatch(batch);
      return;
    }
    this.stats.passes++;
    this.stats.ordersWritten += batch.orders.length;
    this.stats.lastMs = performance.now() - start;
    this.metrics?.writeBehind({ batchSize: batch.orders.length, seconds: this.stats.lastMs / 1000, ok: true });
    batch.ack?.();
  }
}
