import { generateOrders, type Order } from '@apeiron/logos';
import { describe, expect, it } from 'vitest';
import { InMemoryOrderRepository } from './in-memory-order-repository.js';
import { runOrderRepositoryContract } from './repository.contract.js';

async function loadFirstBatch(repo: InMemoryOrderRepository): Promise<Order[]> {
  for await (const batch of repo.loadAll()) return batch;
  return [];
}

runOrderRepositoryContract('in-memory fake', () =>
  Promise.resolve({ repo: new InMemoryOrderRepository(), cleanup: () => Promise.resolve() }),
);

describe('InMemoryOrderRepository', () => {
  it('isolates stored data from caller mutation', async () => {
    const repo = new InMemoryOrderRepository();
    const order = generateOrders(1, 100_000, Date.UTC(2026, 9, 6, 12)).next().value;
    if (order === undefined) throw new Error('no order');
    await repo.upsertMany([order]);
    order.status = 'LIVE';
    const batch = await loadFirstBatch(repo);
    expect(batch[0]?.status).not.toBe('LIVE');
    if (batch[0] !== undefined) batch[0].filledQty = -1;
    const again = await loadFirstBatch(repo);
    expect(again[0]?.filledQty).not.toBe(-1);
  });
});
