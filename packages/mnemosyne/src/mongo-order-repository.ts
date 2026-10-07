import type { Order } from '@apeiron/logos';
import { MongoClient, MongoServerError, type Collection, type Db } from 'mongodb';
import { DEFAULT_BATCH_SIZE, type OrderRepository } from './order-repository.js';

const COLLECTION = 'orders';

type OrderDoc = Order & { _id: string };

export type MongoRepositoryOptions = {
  url: string;
  db: string;
  /** Collection name; defaults to `orders`. */
  collection?: string;
};

/**
 * Mongo adapter. Documents use `orderId` as `_id`. Indexes: `{traderId, createdAt: -1}` and
 * `{status}`. Writes are unordered `bulkWrite` upserts.
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
  }

  async *loadAll(batchSize: number = DEFAULT_BATCH_SIZE): AsyncGenerator<Order[]> {
    const cursor = this.orders
      .find({}, { projection: { _id: 0 } })
      .sort({ _id: 1 })
      .batchSize(batchSize);
    try {
      let batch: Order[] = [];
      for await (const doc of cursor) {
        batch.push(doc as unknown as Order);
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

  async upsertMany(orders: readonly Order[]): Promise<void> {
    if (orders.length === 0) return;
    await this.orders.bulkWrite(
      orders.map((order) => ({
        replaceOne: { filter: { _id: order.orderId }, replacement: order, upsert: true },
      })),
      { ordered: false },
    );
  }

  async loadCurrent(): Promise<Order[]> {
    const docs = await this.orders
      .find({ status: { $in: ['PENDING_START', 'LIVE', 'PAUSED'] } }, { projection: { _id: 0 } })
      .sort({ _id: 1 })
      .toArray();
    return docs as unknown as Order[];
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
