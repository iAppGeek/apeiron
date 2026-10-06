import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoOrderRepository } from './mongo-order-repository.js';
import { runOrderRepositoryContract } from './repository.contract.js';

let server: MongoMemoryServer;
let dbCounter = 0;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
});
afterAll(async () => {
  await server.stop();
});

async function connect(): Promise<MongoOrderRepository> {
  dbCounter += 1;
  return MongoOrderRepository.connect({ url: server.getUri(), db: `contract_${dbCounter}` });
}

runOrderRepositoryContract('MongoOrderRepository', async () => {
  const repo = await connect();
  return {
    repo,
    cleanup: async (): Promise<void> => {
      await repo.database.dropDatabase();
      await repo.close();
    },
  };
});

describe('MongoOrderRepository specifics', () => {
  it('creates the documented indexes', async () => {
    const repo = await connect();
    try {
      const indexes = await repo.database.collection('orders').indexes();
      const keys = indexes.map((i) => JSON.stringify(i.key));
      expect(keys).toContain(JSON.stringify({ traderId: 1, createdAt: -1 }));
      expect(keys).toContain(JSON.stringify({ status: 1 }));
    } finally {
      await repo.database.dropDatabase();
      await repo.close();
    }
  });

  it('uses orderId as the document _id and clear() keeps the indexes', async () => {
    const repo = await connect();
    try {
      const { generateOrders } = await import('@apeiron/logos');
      const order = generateOrders(1, 100_000, Date.UTC(2026, 9, 6, 12)).next().value;
      if (order === undefined) throw new Error('no order');
      await repo.upsertMany([order]);
      const doc = await repo.database.collection('orders').findOne({});
      expect(doc?._id).toBe(order.orderId);
      await repo.clear();
      expect(await repo.count()).toBe(0);
      expect(await repo.database.collection('orders').indexes()).toHaveLength(3);
    } finally {
      await repo.database.dropDatabase();
      await repo.close();
    }
  });
});
