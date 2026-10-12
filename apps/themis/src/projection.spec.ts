import { MemoryBus, PROJECTION_KEY, sampleOrders, type KvBucket, type Order, type OrderStateRecord, type ProjectionMarker } from '@apeiron/logos';
import { InMemoryOrderRepository, toStoredOrder, type StoredOrder } from '@apeiron/mnemosyne';
import { describe, expect, it, vi } from 'vitest';
import { historyOrders, openOrders } from './testing.js';
import { ensureProjection, rebuildReason, recordOf, reconcileProjection, type ProjectionDeps } from './projection.js';

const log = { info: vi.fn(), warn: vi.fn() };
const stored = (n: number): StoredOrder[] => [...historyOrders(n), ...openOrders(3)].map(toStoredOrder);

async function rig(rows: StoredOrder[] = []): Promise<{ deps: ProjectionDeps; state: KvBucket; meta: KvBucket; repo: InMemoryOrderRepository }> {
  const bus = new MemoryBus();
  const state = bus.kv('ORDER_STATE');
  const meta = bus.kv('ORDER_STATE_META');
  await state.ensure({ history: 1, storage: 'file' });
  await meta.ensure({ history: 1, storage: 'file' });
  const repo = new InMemoryOrderRepository();
  await repo.upsertMany(rows);
  return { deps: { repo, state, meta, log, now: () => 1_000 }, state, meta, repo };
}

const marker = async (meta: KvBucket): Promise<ProjectionMarker> => (await meta.get(PROJECTION_KEY))?.value as ProjectionMarker;

describe('ensureProjection', () => {
  it('builds an empty bucket: records for every order, then a ready marker with the count', async () => {
    const { deps, state, meta } = await rig(stored(25));
    const result = await ensureProjection(deps, false);
    expect(result?.count).toBe(25);
    expect((await state.status()).values).toBe(25);
    const first = stored(25)[0] as StoredOrder;
    expect((await state.get(first.order.orderId))?.value).toEqual(recordOf(first));
    expect(await marker(meta)).toMatchObject({ ready: true, count: 25, builtAt: 1_000 });
    expect((await marker(meta)).epoch).not.toBe('');
  });

  it('writes the marker as not ready before it fills the bucket', async () => {
    const { deps, meta, state } = await rig(stored(5));
    const seen: boolean[] = [];
    const put = state.put.bind(state);
    state.put = async (k, v): Promise<number> => {
      seen.push((await marker(meta)).ready);
      return put(k, v);
    };
    await ensureProjection(deps, false);
    expect(seen).toHaveLength(8);
    expect(seen.every((ready) => !ready)).toBe(true);
  });

  it('does nothing when the marker is ready and the counts agree', async () => {
    const { deps } = await rig(stored(10));
    await ensureProjection(deps, false);
    expect(await ensureProjection(deps, false)).toBeNull();
  });

  it('rebuilds when forced, when the marker is not ready, and when the bucket and database disagree', async () => {
    const { deps, meta, state, repo } = await rig(stored(10));
    await ensureProjection(deps, false);
    expect(await rebuildReason(deps, true)).toMatch(/REBUILD_PROJECTION/);
    await meta.put(PROJECTION_KEY, { ready: false, count: 0, epoch: '', builtAt: 1 });
    expect(await rebuildReason(deps, false)).toMatch(/not ready/);
    await ensureProjection(deps, true);
    await repo.upsertMany(stored(12));
    expect(await rebuildReason(deps, false)).toMatch(/13 values but the database 15/);
    expect((await state.status()).values).toBe(13);
    await ensureProjection(deps, false);
    expect((await state.status()).values).toBe(15);
  });

  it('never deletes keys: an order only the bucket knows survives a rebuild', async () => {
    const { deps, state } = await rig(stored(3));
    await state.put('EXTRA', { v: 1 });
    await ensureProjection(deps, true);
    expect((await state.get('EXTRA'))?.value).toEqual({ v: 1 });
  });

  it('treats an unreadable marker as missing', async () => {
    const { deps, meta } = await rig(stored(2));
    await meta.put(PROJECTION_KEY, { nonsense: true });
    expect(await rebuildReason(deps, false)).toMatch(/no projection marker/);
  });
});

describe('reconcileProjection', () => {
  const withRecords = async (rows: StoredOrder[]): Promise<Awaited<ReturnType<typeof rig>>> => {
    const r = await rig(rows);
    await ensureProjection(r.deps, false);
    return r;
  };

  it('republishes an order whose database version is ahead of the bucket', async () => {
    const rows = stored(8);
    const { deps, repo, state } = await withRecords(rows);
    const target = rows[2] as StoredOrder;
    await repo.upsertMany([{ ...target, v: 5, order: { ...target.order, filledQty: 7, lastUpdateTime: 900 } }]);
    const n = await reconcileProjection(deps, 1_000_000);
    expect(n).toBe(1);
    expect(((await state.get(target.order.orderId))?.value as OrderStateRecord).v).toBe(5);
  });

  it('republishes an order missing from the bucket', async () => {
    const rows = stored(4);
    const { deps, repo, state } = await withRecords(rows);
    const extra = { ...toStoredOrder({ ...(sampleOrders(1)[0] as Order), orderId: 'ALG99999999', lastUpdateTime: 999 }) };
    await repo.upsertMany([extra]);
    expect(await reconcileProjection(deps, 1_000_000)).toBe(1);
    expect((await state.get('ALG99999999'))?.value).toBeDefined();
  });

  it('leaves matching orders alone, and ignores old orders outside the window', async () => {
    const rows = stored(6).map((s, i) => ({ ...s, order: { ...s.order, lastUpdateTime: i } }));
    const { deps, repo, state } = await withRecords(rows);
    const put = vi.spyOn(state, 'put');
    expect(await reconcileProjection(deps, 1_000_000)).toBe(0);
    // An old, terminal order is behind but outside a 10 ms window (now = 1000).
    const old = rows.find((r) => r.order.status === 'FILLED' || r.order.status === 'CANCELLED') as StoredOrder;
    await repo.upsertMany([{ ...old, v: 9 }]);
    expect(await reconcileProjection(deps, 10)).toBe(0);
    expect(put).not.toHaveBeenCalled();
    expect(await reconcileProjection(deps, 1_000_000)).toBe(1);
  });

  it('also checks open orders however old they are', async () => {
    const rows = stored(6);
    const { deps, repo } = await withRecords(rows);
    const open = (await repo.loadOpen())[0];
    if (open === undefined) throw new Error('fixture has no open order');
    await repo.upsertMany([{ ...open, v: open.v + 1, order: { ...open.order, lastUpdateTime: 1 } }]);
    expect(await reconcileProjection(deps, 10)).toBe(1);
  });
});
