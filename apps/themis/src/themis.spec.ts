import { MemoryBus, type KvBucket, type Order, type OrderEvent, type OrderStateRecord } from '@apeiron/logos';
import { InMemoryOrderRepository, toStoredOrder, type OrderRepository } from '@apeiron/mnemosyne';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from './log.js';
import { historyOrders, openOrders } from './testing.js';
import { ThemisMetrics } from './metrics.js';
import { startThemis, type Themis } from './themis.js';

const log = createLogger('error', () => undefined);
const history = historyOrders(5);
const open = openOrders;
const fresh = (i: number): Order => ({ ...(open(1)[0] as Order), orderId: `ALG9000000${i}`, status: 'LIVE' });

async function seeded(rows: Order[] = [...history, ...open(3)]): Promise<InMemoryOrderRepository> {
  const repo = new InMemoryOrderRepository();
  await repo.upsertMany(rows.map(toStoredOrder));
  return repo;
}

const options = (bus: MemoryBus, repo: OrderRepository, extra: { metrics?: ThemisMetrics } = {}): Parameters<typeof startThemis>[0] => ({
  bus,
  repo,
  log,
  groupCommitMs: 2,
  groupCommitMax: 100,
  reconcileWindowMin: 15,
  rebuildProjection: false,
  now: () => 5_000,
  ...extra,
});

const kvRecord = async (kv: KvBucket, id: string): Promise<OrderStateRecord> => (await kv.get(id))?.value as OrderStateRecord;
const update = (orderId: string, patch: Partial<Order>, ts = 1_000): OrderEvent => ({ type: 'UPDATE', order: { orderId, ...patch }, ts });

describe('startThemis: startup', () => {
  it('builds the projection from the database and marks it ready', async () => {
    const bus = new MemoryBus();
    const repo = await seeded();
    const themis = await startThemis(options(bus, repo));
    const state = bus.kv('ORDER_STATE');
    expect((await state.status()).values).toBe(await repo.count());
    expect((await bus.kv('ORDER_STATE_META').get('projection'))?.value).toMatchObject({ ready: true, count: await repo.count() });
    await themis.stop();
  });

  it('reports the open orders it loaded', async () => {
    const themis = await startThemis(options(new MemoryBus(), await seeded()));
    expect(themis.status()).toMatchObject({ status: 'ok', openOrders: 3 });
    expect(themis.debug()).toMatchObject({ openOrders: 3, pendingInstructions: 0 });
    await themis.stop();
    expect(themis.status().status).toBe('stopped');
  });

  it('republishes an order the database is ahead on (crash between the write and the publish)', async () => {
    const bus = new MemoryBus();
    const repo = await seeded();
    const first = await startThemis(options(bus, repo));
    await first.stop();
    const target = (await repo.loadOpen())[0];
    if (target === undefined) throw new Error('no open order');
    await repo.upsertMany([{ ...target, v: target.v + 1, order: { ...target.order, filledQty: 1, lastUpdateTime: 4_999 } }]);
    const second = await startThemis(options(bus, repo));
    expect((await kvRecord(bus.kv('ORDER_STATE'), target.order.orderId)).v).toBe(target.v + 1);
    await second.stop();
  });
});

describe('startThemis: order events', () => {
  async function running(): Promise<{ bus: MemoryBus; repo: InMemoryOrderRepository; themis: Themis; state: KvBucket; metrics: ThemisMetrics; target: Order }> {
    const bus = new MemoryBus();
    const repo = await seeded();
    const metrics = new ThemisMetrics();
    const themis = await startThemis(options(bus, repo, { metrics }));
    const state = bus.kv('ORDER_STATE');
    return { bus, repo, themis, state, metrics, target: (await repo.loadOpen())[0]!.order };
  }

  it('stores an update, publishes the new version and acknowledges the event only afterwards', async () => {
    const { bus, repo, themis, state, target } = await running();
    await bus.publish('orders.events', update(target.orderId, { filledQty: 1234, lastUpdateTime: 1_000 }));
    await themis.flush();
    const stored = (await repo.loadOpen()).find((s) => s.order.orderId === target.orderId);
    expect(stored).toMatchObject({ v: 2, order: { filledQty: 1234 } });
    expect(await kvRecord(state, target.orderId)).toMatchObject({ v: 2, srcTs: 1_000, order: { filledQty: 1234 } });
    // The durable consumer has nothing left to redeliver.
    const redelivered = vi.fn();
    await bus.consume({ stream: 'ORDERS', durable: 'themis', subject: 'orders.events' }, redelivered);
    expect(redelivered).not.toHaveBeenCalled();
    await themis.stop();
  });

  it('versions every change to an order in sequence', async () => {
    const { bus, themis, state, target } = await running();
    for (let i = 1; i <= 5; i++) await bus.publish('orders.events', update(target.orderId, { filledQty: i * 100 }));
    await themis.flush();
    expect(await kvRecord(state, target.orderId)).toMatchObject({ v: 6, order: { filledQty: 500 } });
    await themis.stop();
  });

  it('stores a new order at v = 1 and publishes it', async () => {
    const { bus, repo, themis, state } = await running();
    const order = fresh(1);
    await bus.publish('orders.events', { type: 'NEW', order, ts: 10 });
    await themis.flush();
    expect(await repo.maxOrderId()).toBe(order.orderId);
    expect(await kvRecord(state, order.orderId)).toMatchObject({ v: 1, execSeq: order.numFills, srcTs: 10 });
    await themis.stop();
  });

  it('keeps new orders in ascending order in the bucket', async () => {
    const { bus, themis, state } = await running();
    const keys: string[] = [];
    const watch = await state.watch({ updatesOnly: true });
    void (async (): Promise<void> => {
      for await (const e of watch) keys.push(e.key);
    })();
    for (let i = 1; i <= 4; i++) await bus.publish('orders.events', { type: 'NEW', order: fresh(i), ts: i });
    await themis.flush();
    await watch.close();
    expect(keys).toEqual([1, 2, 3, 4].map((i) => fresh(i).orderId));
    await themis.stop();
  });

  it('drops a finished order from memory once its last version is committed, but can still find it in the bucket', async () => {
    const { bus, themis, state, target } = await running();
    await bus.publish('orders.events', update(target.orderId, { status: 'FILLED', completedAt: 5 }));
    await themis.flush();
    expect(themis.status().openOrders).toBe(2);
    expect(themis.debug()).toMatchObject({ heldOrders: 2 });
    // A late event for the finished order is applied on top of its stored version, not lost as unknown.
    await bus.publish('orders.events', update(target.orderId, { realisedPnlUsd: 42 }));
    await themis.flush();
    expect(await kvRecord(state, target.orderId)).toMatchObject({ v: 3, order: { status: 'FILLED', realisedPnlUsd: 42 } });
    await themis.stop();
  });

  it('ignores replays, unknown orders, rejects and invalid events, and acknowledges them', async () => {
    const { bus, repo, themis, metrics, target } = await running();
    const patch = update(target.orderId, { filledQty: 9 });
    await bus.publish('orders.events', patch);
    await bus.publish('orders.events', patch);
    await bus.publish('orders.events', update('ALG00000000', { filledQty: 1 }));
    await bus.publish('orders.events', { type: 'REJECT', commandId: 'c:1', orderId: target.orderId, code: 'UNKNOWN_ORDER', message: 'x', ts: 1 });
    await bus.publish('orders.events', { type: 'BOGUS' });
    await themis.flush();
    expect((await repo.loadOpen()).find((s) => s.order.orderId === target.orderId)?.v).toBe(2);
    const text = await metrics.render();
    expect(text).toContain('themis_events_total{type="UPDATE",result="applied"} 1');
    expect(text).toContain('themis_events_total{type="UPDATE",result="unchanged"} 1');
    expect(text).toContain('themis_events_total{type="UPDATE",result="unknown"} 1');
    expect(text).toContain('themis_events_total{type="REJECT",result="ignored"} 1');
    expect(text).toContain('themis_events_total{type="invalid",result="invalid"} 1');
    const redelivered = vi.fn();
    await bus.consume({ stream: 'ORDERS', durable: 'themis', subject: 'orders.events' }, redelivered);
    expect(redelivered).not.toHaveBeenCalled();
    await themis.stop();
  });

  it('loses no write when it dies before committing: a new instance replays from its durable consumer', async () => {
    const bus = new MemoryBus();
    const rows = [...history, ...open(3)];
    const stuck = await seeded(rows);
    stuck.upsertMany = (): Promise<void> => new Promise(() => undefined);
    // The first run seeds the projection with a working repository, then loses its database.
    const reference = await seeded(rows);
    await (await startThemis(options(bus, reference))).stop();
    const dying: Themis = await startThemis(options(bus, stuck));
    const target = (await reference.loadOpen())[0]!.order;
    await bus.publish('orders.events', update(target.orderId, { filledQty: 111 }));
    await bus.publish('orders.events', update(target.orderId, { filledQty: 222 }));
    await bus.publish('orders.events', { type: 'NEW', order: fresh(7), ts: 3 });
    await dying.stop({ flush: false });

    const revived = await startThemis(options(bus, reference));
    await revived.flush();
    expect((await reference.loadOpen()).find((s) => s.order.orderId === target.orderId)).toMatchObject({ v: 3, order: { filledQty: 222 } });
    expect(await reference.maxOrderId()).toBe(fresh(7).orderId);
    expect(await kvRecord(bus.kv('ORDER_STATE'), fresh(7).orderId)).toMatchObject({ v: 1 });
    await revived.stop();
  });
});
