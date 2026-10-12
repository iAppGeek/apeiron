import type { CurrencyPair } from '@apeiron/logos';
import { DEFAULT_BATCH_SIZE, latestMidsOf, type OrderRepository, type StoredOrder } from './order-repository.js';

const OPEN = new Set(['PENDING_START', 'LIVE', 'PAUSED']);

/** In-memory fake used by unit tests of services that depend on {@link OrderRepository}. */
export class InMemoryOrderRepository implements OrderRepository {
  private readonly records = new Map<string, StoredOrder>();

  async *loadAll(batchSize: number = DEFAULT_BATCH_SIZE): AsyncGenerator<StoredOrder[]> {
    yield* this.batches([...this.records.keys()].sort(), batchSize);
  }

  async *loadUpdatedSince(ts: number, batchSize: number = DEFAULT_BATCH_SIZE): AsyncGenerator<StoredOrder[]> {
    const ids = [...this.records.values()].filter((r) => r.order.lastUpdateTime >= ts).map((r) => r.order.orderId).sort();
    yield* this.batches(ids, batchSize);
  }

  upsertMany(records: readonly StoredOrder[]): Promise<void> {
    for (const record of records) this.records.set(record.order.orderId, structuredClone(record));
    return Promise.resolve();
  }

  loadOpen(): Promise<StoredOrder[]> {
    const open = [...this.records.values()]
      .filter((r) => OPEN.has(r.order.status))
      .sort((a, b) => (a.order.orderId < b.order.orderId ? -1 : 1));
    return Promise.resolve(open.map((r) => structuredClone(r)));
  }

  async latestMidsByPair(): Promise<Record<CurrencyPair, number>> {
    return latestMidsOf((await this.loadOpen()).map((r) => r.order));
  }

  maxOrderId(): Promise<string | null> {
    let max: string | null = null;
    for (const id of this.records.keys()) if (max === null || id > max) max = id;
    return Promise.resolve(max);
  }

  count(): Promise<number> {
    return Promise.resolve(this.records.size);
  }

  clear(): Promise<void> {
    this.records.clear();
    return Promise.resolve();
  }

  isSeeded(): Promise<boolean> {
    return Promise.resolve(this.records.size > 0);
  }

  private *batches(ids: string[], batchSize: number): Generator<StoredOrder[]> {
    for (let i = 0; i < ids.length; i += batchSize) {
      yield ids.slice(i, i + batchSize).map((id) => structuredClone(this.records.get(id) as StoredOrder));
    }
  }
}
