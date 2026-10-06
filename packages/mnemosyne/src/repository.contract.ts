import { generateOrders, type Order } from '@apeiron/logos';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrderRepository } from './order-repository.js';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

export type RepositoryHarness = {
  repo: OrderRepository;
  /** Releases connections and removes data. */
  cleanup: () => Promise<void>;
};

/** Deterministic orders: historical ones plus (for n >= 12) the final 6 LIVE/PENDING_START orders. */
function orders(n: number, seed = 42): Order[] {
  const all = [...generateOrders(seed, 10_000, NOW)];
  if (n < 12) return all.slice(0, n);
  return [...all.slice(0, n - 6), ...all.slice(-6)];
}

async function collect(repo: OrderRepository, batchSize?: number): Promise<Order[][]> {
  const batches: Order[][] = [];
  for await (const batch of repo.loadAll(batchSize)) batches.push(batch);
  return batches;
}

/**
 * Behavioural contract every {@link OrderRepository} adapter (Mongo, in-memory, and future Oracle/KDB)
 * must satisfy. `create` must return a fresh, empty repository for each test.
 */
export function runOrderRepositoryContract(name: string, create: () => Promise<RepositoryHarness>): void {
  describe(`OrderRepository contract: ${name}`, () => {
    let harness: RepositoryHarness;
    let repo: OrderRepository;

    beforeEach(async () => {
      harness = await create();
      repo = harness.repo;
    });
    afterEach(async () => {
      await harness.cleanup();
    });

    it('starts empty', async () => {
      expect(await repo.count()).toBe(0);
      expect(await repo.isSeeded()).toBe(false);
      expect(await collect(repo)).toEqual([]);
    });

    it('stores orders and reports count and isSeeded', async () => {
      await repo.upsertMany(orders(25));
      expect(await repo.count()).toBe(25);
      expect(await repo.isSeeded()).toBe(true);
    });

    it('treats an empty upsert as a no-op', async () => {
      await repo.upsertMany([]);
      expect(await repo.count()).toBe(0);
      expect(await repo.isSeeded()).toBe(false);
    });

    it('is idempotent: upserting the same orders again does not grow the set', async () => {
      const data = orders(40);
      await repo.upsertMany(data);
      await repo.upsertMany(data);
      expect(await repo.count()).toBe(40);
    });

    it('replaces an existing order by orderId', async () => {
      const [first] = orders(1) as [Order];
      await repo.upsertMany([first]);
      await repo.upsertMany([{ ...first, status: 'CANCELLED', filledQty: 5, remainingQty: first.orderQty - 5 }]);
      const rows = (await collect(repo)).flat();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ orderId: first.orderId, status: 'CANCELLED', filledQty: 5 });
    });

    it('round-trips every field exactly, including nulls', async () => {
      const data = orders(300);
      expect(data.some((o) => o.limitPrice === null)).toBe(true);
      expect(data.some((o) => o.completedAt === null)).toBe(true);
      await repo.upsertMany(data);
      const loaded = (await collect(repo)).flat();
      expect(loaded).toEqual([...data].sort((a, b) => (a.orderId < b.orderId ? -1 : 1)));
      for (const o of loaded) expect(Object.keys(o)).toHaveLength(50);
    });

    it('streams in ascending orderId order regardless of insertion order', async () => {
      const data = orders(60);
      await repo.upsertMany([...data].reverse());
      const ids = (await collect(repo)).flat().map((o) => o.orderId);
      expect(ids).toEqual(data.map((o) => o.orderId));
    });

    it('streams in batches no larger than batchSize', async () => {
      await repo.upsertMany(orders(250));
      const batches = await collect(repo, 100);
      expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
    });

    it('streams larger sets as several full batches plus a remainder', async () => {
      await repo.upsertMany(orders(1200));
      const batches = await collect(repo, 500);
      expect(batches.map((b) => b.length)).toEqual([500, 500, 200]);
    });

    it('supports early termination and a later full load', async () => {
      await repo.upsertMany(orders(300));
      for await (const batch of repo.loadAll(100)) {
        expect(batch).toHaveLength(100);
        break;
      }
      expect((await collect(repo, 100)).flat()).toHaveLength(300);
    });

    it('clear() removes everything, is idempotent, and the repository is reusable afterwards', async () => {
      await repo.upsertMany(orders(50));
      await repo.clear();
      expect(await repo.count()).toBe(0);
      expect(await repo.isSeeded()).toBe(false);
      expect(await collect(repo)).toEqual([]);
      await repo.clear();
      await repo.upsertMany(orders(10));
      expect(await repo.count()).toBe(10);
    });

    it('stays correct across several upsert calls', async () => {
      const data = orders(90);
      await repo.upsertMany(data.slice(0, 30));
      await repo.upsertMany(data.slice(30, 60));
      await repo.upsertMany(data.slice(60));
      expect(await repo.count()).toBe(90);
    });
  });
}
