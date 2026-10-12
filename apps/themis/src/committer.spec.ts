import { MemoryBus, sampleOrders, type KvBucket, type Order, type OrderStateRecord } from '@apeiron/logos';
import { InMemoryOrderRepository, toStoredOrder, type OrderRepository, type StoredOrder } from '@apeiron/mnemosyne';
import { describe, expect, it, vi } from 'vitest';
import { GroupCommitter, toStateRecord } from './committer.js';

const orders = sampleOrders(5);
const rec = (i: number, v = 1): StoredOrder => ({ ...toStoredOrder(orders[i] as Order), v });
const log = { warn: vi.fn() };

async function rig(overrides: { repo?: OrderRepository; windowMs?: number; maxBatch?: number } = {}): Promise<{ committer: GroupCommitter; repo: OrderRepository; state: KvBucket; events: string[] }> {
  const bus = new MemoryBus();
  const state = bus.kv('ORDER_STATE');
  await state.ensure({ history: 1, storage: 'file' });
  const repo = overrides.repo ?? new InMemoryOrderRepository();
  const events: string[] = [];
  const committer = new GroupCommitter({ repo, state, log, windowMs: overrides.windowMs ?? 5, maxBatch: overrides.maxBatch ?? 500, backoffMs: 1 });
  return { committer, repo, state, events };
}

describe('GroupCommitter', () => {
  it('stores a change, then publishes it, then runs done', async () => {
    const { committer, repo, state } = await rig();
    const seen: string[] = [];
    const done = vi.fn(async () => {
      seen.push(`done:${await repo.count()}:${(await state.status()).values}`);
    });
    committer.submit(rec(0, 3), 77, () => void done());
    await committer.flush();
    expect(done).toHaveBeenCalledOnce();
    expect(seen).toEqual(['done:1:1']);
    const kv = await state.get(rec(0).order.orderId);
    expect(kv?.value).toEqual(toStateRecord(rec(0, 3), 77));
  });

  it('writes to the database before it publishes to the bucket', async () => {
    const { committer, state } = await rig();
    const order: string[] = [];
    const repo = new InMemoryOrderRepository();
    const upsert = repo.upsertMany.bind(repo);
    repo.upsertMany = async (r): Promise<void> => {
      order.push('db:start');
      await new Promise((resolve) => setTimeout(resolve, 10));
      await upsert(r);
      order.push('db:end');
    };
    const put = state.put.bind(state);
    state.put = (k, v): Promise<number> => {
      order.push('kv');
      return put(k, v);
    };
    const c = new GroupCommitter({ repo, state, log, windowMs: 1, maxBatch: 10 });
    c.submit(rec(1), 1);
    await c.flush();
    expect(order).toEqual(['db:start', 'db:end', 'kv']);
    void committer;
  });

  it('commits within the window, batching changes that arrive together', async () => {
    const { committer, repo } = await rig({ windowMs: 20 });
    const spy = vi.spyOn(repo, 'upsertMany');
    for (let i = 0; i < 4; i++) committer.submit(rec(i), i);
    expect(spy).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toHaveLength(4);
    expect(committer.stats).toMatchObject({ batches: 1, changes: 4, lastSize: 4 });
  });

  it('commits at once when maxBatch changes are waiting', async () => {
    const { committer, repo } = await rig({ windowMs: 10_000, maxBatch: 3 });
    const spy = vi.spyOn(repo, 'upsertMany');
    for (let i = 0; i < 3; i++) committer.submit(rec(i), i);
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await committer.flush();
  });

  it('collapses several changes to one order into the latest, keeping the first one position', async () => {
    const { committer, repo, state } = await rig();
    const spy = vi.spyOn(repo, 'upsertMany');
    committer.submit(rec(0, 1), 1);
    committer.submit(rec(1, 1), 2);
    committer.submit(rec(0, 2), 3);
    await committer.flush();
    expect(spy.mock.calls[0]?.[0].map((r) => [r.order.orderId, r.v])).toEqual([
      [rec(0).order.orderId, 2],
      [rec(1).order.orderId, 1],
    ]);
    expect(((await state.get(rec(0).order.orderId))?.value as OrderStateRecord).v).toBe(2);
  });

  it('runs every done callback, in order, even for the changes that were collapsed', async () => {
    const { committer } = await rig();
    const ran: number[] = [];
    committer.submit(rec(0, 1), 1, () => ran.push(1));
    committer.submit(rec(0, 2), 2, () => ran.push(2));
    committer.whenCommitted(() => ran.push(3));
    await committer.flush();
    expect(ran).toEqual([1, 2, 3]);
  });

  it('whenCommitted runs at once when nothing is waiting, and after the pending batch otherwise', async () => {
    const { committer } = await rig({ windowMs: 5 });
    const ran: string[] = [];
    committer.whenCommitted(() => ran.push('idle'));
    expect(ran).toEqual(['idle']);
    committer.submit(rec(0), 1, () => ran.push('change'));
    committer.whenCommitted(() => ran.push('marker'));
    expect(ran).toEqual(['idle']);
    await committer.flush();
    expect(ran).toEqual(['idle', 'change', 'marker']);
  });

  it('retries a failed database write with backoff and loses nothing', async () => {
    const repo = new InMemoryOrderRepository();
    const real = repo.upsertMany.bind(repo);
    let failures = 2;
    repo.upsertMany = (r): Promise<void> => (failures-- > 0 ? Promise.reject(new Error('mongo down')) : real(r));
    const { committer, state } = await rig({ repo });
    const done = vi.fn();
    committer.submit(rec(0), 1, done);
    await committer.flush();
    expect(done).toHaveBeenCalledOnce();
    expect(await repo.count()).toBe(1);
    expect((await state.status()).values).toBe(1);
    expect(log.warn).toHaveBeenCalled();
  });

  it('retries a failed publish after the database write, and replies only once it succeeds', async () => {
    const { committer, repo, state } = await rig();
    const real = state.put.bind(state);
    let failures = 1;
    state.put = (k, v): Promise<number> => (failures-- > 0 ? Promise.reject(new Error('nats down')) : real(k, v));
    const done = vi.fn();
    committer.submit(rec(0), 1, done);
    await committer.flush();
    expect(done).toHaveBeenCalledOnce();
    expect(await repo.count()).toBe(1);
    expect((await state.get(rec(0).order.orderId))?.value).toBeDefined();
  });

  it('issues puts in commit order so new ids arrive ascending', async () => {
    const { committer, state } = await rig();
    const keys: string[] = [];
    const real = state.put.bind(state);
    state.put = (k, v): Promise<number> => {
      keys.push(k);
      return real(k, v);
    };
    const ids = [0, 1, 2, 3].map((i) => rec(i));
    for (const r of ids) committer.submit(r, 1);
    await committer.flush();
    expect(keys).toEqual(ids.map((r) => r.order.orderId));
  });

  it('reports batch and publish timings to the metrics', async () => {
    const bus = new MemoryBus();
    const state = bus.kv('S');
    await state.ensure({ history: 1, storage: 'file' });
    const metrics = { commit: vi.fn(), kvPut: vi.fn() };
    const c = new GroupCommitter({ repo: new InMemoryOrderRepository(), state, log, windowMs: 1, maxBatch: 10, metrics });
    c.submit(rec(0), 1);
    c.submit(rec(1), 1);
    await c.flush();
    expect(metrics.commit).toHaveBeenCalledWith(expect.objectContaining({ batchSize: 2 }));
    expect(metrics.kvPut).toHaveBeenCalledOnce();
  });

  it('stop commits what is queued', async () => {
    const { committer, repo } = await rig({ windowMs: 10_000 });
    committer.submit(rec(0), 1);
    await committer.stop();
    expect(await repo.count()).toBe(1);
  });
});
