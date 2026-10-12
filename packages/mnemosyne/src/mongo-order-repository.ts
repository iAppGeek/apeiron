import type { CurrencyPair, Order, OrderStatus } from '@apeiron/logos';
import { MongoClient, MongoServerError, type Collection, type Db, type Filter } from 'mongodb';
import { DEFAULT_BATCH_SIZE, latestMidsOf, type OrderRepository, type StoredOrder } from './order-repository.js';

const COLLECTION = 'orders';

/** A stored document: the 50 fields, the id, and the counters (absent in documents written before PLAN1). */
type OrderDoc = Order & { _id: string; _v?: number; _execSeq?: number };

const OPEN_STATUSES: OrderStatus[] = ['PENDING_START', 'LIVE', 'PAUSED'];

const fromDoc = (doc: Omit<OrderDoc, '_id'>): StoredOrder => {
  const { _v, _execSeq, ...order } = doc;
  return { order, v: _v ?? 1, execSeq: _execSeq ?? order.numFills };
};

const toDoc = ({ order, v, execSeq }: StoredOrder): OrderDoc => ({ ...order, _id: order.orderId, _v: v, _execSeq: execSeq });

export type MongoRepositoryOptions = {
  url: string;
  db: string;
  /** Collection name; defaults to `orders`. */
  collection?: string;
};

/**
 * Mongo adapter. Documents use `orderId` as `_id` and carry `_v` and `_execSeq` beside the 50 fields. Indexes:
 * `{traderId, createdAt: -1}`, `{status}` and `{lastUpdateTime: -1}`. Writes are unordered `bulkWrite` upserts.
 */
export class MongoOrderRepository implements OrderRepository {
  private constructor(
    private readonly client: MongoClient,
    private readonly db: Db,
    private readonly orders: Collection<OrderDoc>,
  ) {}

  /** Connects and ensures the indexes exist. */
  static async connect(options: MongoRepositoryOptions): Promise<MongoOrderRepository> {
    const client = new MongoClient(options.url);
    await client.connect();
    const db = client.db(options.db);
    const repo = new MongoOrderRepository(client, db, db.collection<OrderDoc>(options.collection ?? COLLECTION));
    await repo.ensureIndexes();
    return repo;
  }

  async ensureIndexes(): Promise<void> {
    await this.orders.createIndex({ traderId: 1, createdAt: -1 }, { name: 'traderId_createdAt' });
    await this.orders.createIndex({ status: 1 }, { name: 'status' });
    await this.orders.createIndex({ lastUpdateTime: -1 }, { name: 'lastUpdateTime' });
  }

  loadAll(batchSize: number = DEFAULT_BATCH_SIZE): AsyncGenerator<StoredOrder[]> {
    return this.stream({}, batchSize);
  }

  loadUpdatedSince(ts: number, batchSize: number = DEFAULT_BATCH_SIZE): AsyncGenerator<StoredOrder[]> {
    return this.stream({ lastUpdateTime: { $gte: ts } }, batchSize);
  }

  private async *stream(filter: Filter<OrderDoc>, batchSize: number): AsyncGenerator<StoredOrder[]> {
    const cursor = this.orders
      .find(filter, { projection: { _id: 0 } })
      .sort({ _id: 1 })
      .batchSize(batchSize);
    try {
      let batch: StoredOrder[] = [];
      for await (const doc of cursor) {
        batch.push(fromDoc(doc));
        if (batch.length >= batchSize) {
          yield batch;
          batch = [];
        }
      }
      if (batch.length > 0) yield batch;
    } finally {
      await cursor.close();
    }
  }

  async upsertMany(records: readonly StoredOrder[]): Promise<void> {
    if (records.length === 0) return;
    await this.orders.bulkWrite(
      records.map((record) => ({
        replaceOne: { filter: { _id: record.order.orderId }, replacement: toDoc(record), upsert: true },
      })),
      { ordered: false },
    );
  }

  async loadOpen(): Promise<StoredOrder[]> {
    const docs = await this.orders
      .find({ status: { $in: OPEN_STATUSES } }, { projection: { _id: 0 } })
      .sort({ _id: 1 })
      .toArray();
    return docs.map(fromDoc);
  }

  async latestMidsByPair(): Promise<Record<CurrencyPair, number>> {
    return latestMidsOf((await this.loadOpen()).map((r) => r.order));
  }

  async maxOrderId(): Promise<string | null> {
    const doc = await this.orders.find({}, { projection: { _id: 1 } }).sort({ _id: -1 }).limit(1).next();
    return doc === null ? null : doc._id;
  }

  count(): Promise<number> {
    return this.orders.countDocuments({});
  }

  async isSeeded(): Promise<boolean> {
    return (await this.orders.findOne({}, { projection: { _id: 1 } })) !== null;
  }

  /** Drops the collection (much faster than deleteMany at 1M rows) and recreates the indexes. */
  async clear(): Promise<void> {
    try {
      await this.orders.drop();
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.codeName !== 'NamespaceNotFound') throw error;
    }
    await this.ensureIndexes();
  }

  get database(): Db {
    return this.db;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
