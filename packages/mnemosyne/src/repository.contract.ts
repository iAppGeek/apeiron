import { PAIRS, generateOrders, type Order } from '@apeiron/logos';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toStoredOrder, type OrderRepository, type StoredOrder } from './order-repository.js';

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

const stored = (list: readonly Order[]): StoredOrder[] => list.map(toStoredOrder);

async function collect(repo: OrderRepository, batchSize?: number): Promise<StoredOrder[][]> {
  const batches: StoredOrder[][] = [];
  for await (const batch of repo.loadAll(batchSize)) batches.push(batch);
  return batches;
}

async function collectUpdated(repo: OrderRepository, ts: number, batchSize?: number): Promise<StoredOrder[][]> {
  const batches: StoredOrder[][] = [];
  for await (const batch of repo.loadUpdatedSince(ts, batchSize)) batches.push(batch);
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
      await repo.upsertMany(stored(orders(25)));
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
      await repo.upsertMany(stored(data));
      await repo.upsertMany(stored(data));
      expect(await repo.count()).toBe(40);
    });

    it('replaces an existing order by orderId', async () => {
      const [first] = orders(1) as [Order];
      await repo.upsertMany(stored([first]));
      await repo.upsertMany(stored([{ ...first, status: 'CANCELLED', filledQty: 5, remainingQty: first.orderQty - 5 }]));
      const rows = (await collect(repo)).flat();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.order).toMatchObject({ orderId: first.orderId, status: 'CANCELLED', filledQty: 5 });
    });

    it('round-trips every field exactly, including nulls', async () => {
      const data = orders(300);
      expect(data.some((o) => o.limitPrice === null)).toBe(true);
      expect(data.some((o) => o.completedAt === null)).toBe(true);
      await repo.upsertMany(stored(data));
      const loaded = (await collect(repo)).flat();
      expect(loaded.map((r) => r.order)).toEqual([...data].sort((a, b) => (a.orderId < b.orderId ? -1 : 1)));
      for (const r of loaded) expect(Object.keys(r.order)).toHaveLength(50);
    });

    it('streams in ascending orderId order regardless of insertion order', async () => {
      const data = orders(60);
      await repo.upsertMany(stored([...data].reverse()));
      const ids = (await collect(repo)).flat().map((r) => r.order.orderId);
      expect(ids).toEqual(data.map((o) => o.orderId));
    });

    it('streams in batches no larger than batchSize', async () => {
      await repo.upsertMany(stored(orders(250)));
      const batches = await collect(repo, 100);
      expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
    });

    it('streams larger sets as several full batches plus a remainder', async () => {
      await repo.upsertMany(stored(orders(1200)));
      const batches = await collect(repo, 500);
      expect(batches.map((b) => b.length)).toEqual([500, 500, 200]);
    });

    it('supports early termination and a later full load', async () => {
      await repo.upsertMany(stored(orders(300)));
      for await (const batch of repo.loadAll(100)) {
        expect(batch).toHaveLength(100);
        break;
      }
      expect((await collect(repo, 100)).flat()).toHaveLength(300);
    });

    it('clear() removes everything, is idempotent, and the repository is reusable afterwards', async () => {
      await repo.upsertMany(stored(orders(50)));
      await repo.clear();
      expect(await repo.count()).toBe(0);
      expect(await repo.isSeeded()).toBe(false);
      expect(await collect(repo)).toEqual([]);
      await repo.clear();
      await repo.upsertMany(stored(orders(10)));
      expect(await repo.count()).toBe(10);
    });

    it('stays correct across several upsert calls', async () => {
      const data = orders(90);
      await repo.upsertMany(stored(data.slice(0, 30)));
      await repo.upsertMany(stored(data.slice(30, 60)));
      await repo.upsertMany(stored(data.slice(60)));
      expect(await repo.count()).toBe(90);
    });

    it('loadOpen returns only PENDING_START, LIVE and PAUSED orders, ascending by orderId', async () => {
      expect(await repo.loadOpen()).toEqual([]);
      const base = orders(12);
      const statuses = ['FILLED', 'LIVE', 'CANCELLED', 'PAUSED', 'PENDING_START', 'LIVE'] as const;
      const data = base.slice(0, 6).map((o, i): Order => ({ ...o, status: statuses[i] ?? 'FILLED' }));
      await repo.upsertMany(stored([...data].reverse()));
      const current = await repo.loadOpen();
      expect(current.map((r) => r.order.status)).toEqual(['LIVE', 'PAUSED', 'PENDING_START', 'LIVE']);
      expect(current.map((r) => r.order.orderId)).toEqual(
        [data[1], data[3], data[4], data[5]].map((o) => (o as Order).orderId),
      );
      expect(current[0]?.order).toEqual(data[1]);
    });

    it('loadOpen follows status changes made by upsert', async () => {
      const [first] = orders(1) as [Order];
      await repo.upsertMany(stored([{ ...first, status: 'LIVE' }]));
      expect(await repo.loadOpen()).toHaveLength(1);
      await repo.upsertMany(stored([{ ...first, status: 'FILLED' }]));
      expect(await repo.loadOpen()).toEqual([]);
    });

    it('maxOrderId is null when empty and the highest id otherwise', async () => {
      expect(await repo.maxOrderId()).toBeNull();
      const data = orders(30);
      await repo.upsertMany(stored([...data].reverse()));
      const sorted = data.map((o) => o.orderId).sort();
      expect(await repo.maxOrderId()).toBe(sorted[sorted.length - 1]);
      await repo.clear();
      expect(await repo.maxOrderId()).toBeNull();
    });

    it('round-trips v and execSeq, and replaces them on upsert', async () => {
      const [first] = orders(1) as [Order];
      await repo.upsertMany([{ order: first, v: 7, execSeq: 4 }]);
      expect((await collect(repo)).flat()).toEqual([{ order: first, v: 7, execSeq: 4 }]);
      await repo.upsertMany([{ order: { ...first, numFills: 9 }, v: 8, execSeq: 5 }]);
      expect((await collect(repo)).flat()).toEqual([{ order: { ...first, numFills: 9 }, v: 8, execSeq: 5 }]);
    });

    it('loadOpen returns v and execSeq with the order', async () => {
      const [first] = orders(1) as [Order];
      await repo.upsertMany([{ order: { ...first, status: 'LIVE' }, v: 3, execSeq: 2 }]);
      expect(await repo.loadOpen()).toEqual([{ order: { ...first, status: 'LIVE' }, v: 3, execSeq: 2 }]);
    });

    it('loadUpdatedSince streams orders at or after the time, ascending by orderId, in batches', async () => {
      expect(await collectUpdated(repo, 0)).toEqual([]);
      const data = orders(40).map((o, i): Order => ({ ...o, lastUpdateTime: 1_000 + i }));
      await repo.upsertMany(stored([...data].reverse()));
      const since = await collectUpdated(repo, 1_030, 4);
      expect(since.map((b) => b.length)).toEqual([4, 4, 2]);
      const ids = since.flat().map((r) => r.order.orderId);
      expect(ids).toEqual(data.filter((o) => o.lastUpdateTime >= 1_030).map((o) => o.orderId).sort());
      expect((await collectUpdated(repo, 1_000)).flat()).toHaveLength(40);
      expect(await collectUpdated(repo, 5_000)).toEqual([]);
    });

    it('latestMidsByPair uses the most recently updated open order, else the reference level', async () => {
      const base = orders(12);
      const eur = (o: Order, patch: Partial<Order>): Order => ({ ...o, currencyPair: 'EURUSD', ...patch });
      const data = [
        eur(base[0] as Order, { status: 'LIVE', marketMid: 1.1, lastUpdateTime: 100 }),
        eur(base[1] as Order, { status: 'PAUSED', marketMid: 1.2, lastUpdateTime: 300 }),
        eur(base[2] as Order, { status: 'FILLED', marketMid: 9.9, lastUpdateTime: 900 }),
      ];
      await repo.upsertMany(stored(data));
      const mids = await repo.latestMidsByPair();
      expect(mids.EURUSD).toBe(1.2);
      expect(mids.USDJPY).toBe(PAIRS.find((p) => p.pair === 'USDJPY')?.mid);
      expect(Object.keys(mids)).toHaveLength(PAIRS.length);
    });
  });
}
