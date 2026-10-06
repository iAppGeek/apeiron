import type { Order } from '@apeiron/logos';
import { InMemoryOrderRepository } from '@apeiron/mnemosyne';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOAD_BATCH_SIZE, loadStore } from './loader.js';
import { ColumnarStore } from './store/columnar-store.js';
import { makeOrders } from './testing/orders.js';

async function repoWith(orders: Order[]): Promise<InMemoryOrderRepository> {
  const repo = new InMemoryOrderRepository();
  await repo.upsertMany(orders);
  return repo;
}

describe('loadStore', () => {
  it('streams every order into the store in batches and reports memory and lag', async () => {
    const orders = makeOrders(Array.from({ length: 250 }, (_, i) => ({ orderQty: i })));
    const repo = await repoWith(orders);
    const spy = vi.spyOn(repo, 'loadAll');
    const store = new ColumnarStore({ capacity: 10 });
    const report = await loadStore(repo, store, { batchSize: 100 });
    expect(spy).toHaveBeenCalledWith(100);
    expect(store.size).toBe(250);
    expect(store.rowAt(7).orderQty).toBe(7);
    expect(report.rows).toBe(250);
    expect(report.loadMs).toBeGreaterThanOrEqual(report.rankMs);
    expect(store.stringRank('clientOrderId')).toHaveLength(250);
    expect(report.before.heapMb).toBeGreaterThan(0);
    expect(report.afterGc?.heapMb).toBeGreaterThan(0);
    expect(report.lag.samples).toBeGreaterThan(0);
    expect(report.store.typedUsedBytes).toBeGreaterThan(0);
  });

  it('streams in 200-row batches by default', async () => {
    const repo = await repoWith(makeOrders([{ orderQty: 1 }]));
    const spy = vi.spyOn(repo, 'loadAll');
    await loadStore(repo, new ColumnarStore({ capacity: 4 }));
    expect(spy).toHaveBeenCalledWith(DEFAULT_LOAD_BATCH_SIZE);
    expect(DEFAULT_LOAD_BATCH_SIZE).toBe(200);
  });

  it('loads an empty repository', async () => {
    const store = new ColumnarStore({ capacity: 4 });
    const report = await loadStore(await repoWith([]), store);
    expect(report.rows).toBe(0);
  });

  it('propagates repository failures', async () => {
    const repo = await repoWith([]);
    vi.spyOn(repo, 'loadAll').mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(loadStore(repo, new ColumnarStore({ capacity: 4 }))).rejects.toThrow('boom');
  });

  it('logs progress for slow loads', async () => {
    const orders = makeOrders([{ orderQty: 1 }, { orderQty: 2 }]);
    const repo = await repoWith(orders);
    const log = vi.fn();
    const now = vi.spyOn(performance, 'now');
    let t = 0;
    now.mockImplementation(() => (t += 6_000));
    await loadStore(repo, new ColumnarStore({ capacity: 4 }), { log, batchSize: 1 });
    now.mockRestore();
    expect(log).toHaveBeenCalledWith('loading', expect.objectContaining({ rows: expect.any(Number) }));
  });
});
