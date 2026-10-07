import { MemoryBus, type Order, type OrderEvent, type PriceTick } from '@apeiron/logos';
import { InMemoryOrderRepository } from '@apeiron/mnemosyne';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryEngine } from '../query/engine.js';
import { ClientSession } from '../session.js';
import { ColumnarStore } from '../store/columnar-store.js';
import { makeOrders } from '../testing/orders.js';
import type { Connection, Frame } from '../transport.js';
import { LiveRuntime } from './runtime.js';
import { jsonCodec, type ServerMsg } from '@apeiron/logos';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const LIVE: Partial<Order> = {
  status: 'LIVE',
  currencyPair: 'EURUSD',
  side: 'BUY',
  traderId: 'T1',
  orderQty: 1_000_000,
  filledQty: 400_000,
  remainingQty: 600_000,
  avgFillPrice: 1.08,
  arrivalPrice: 1.08,
  notionalUsd: 1_080_000,
  marketMid: 1.08,
};

type Rig = {
  bus: MemoryBus;
  repo: InMemoryOrderRepository;
  store: ColumnarStore;
  engine: QueryEngine;
  runtime: LiveRuntime;
  orders: Order[];
};

async function rig(options: { bus?: MemoryBus; repo?: InMemoryOrderRepository; rows?: Partial<Order>[] } = {}): Promise<Rig> {
  const bus = options.bus ?? new MemoryBus();
  const repo = options.repo ?? new InMemoryOrderRepository();
  const orders = makeOrders(options.rows ?? [{ ...LIVE }, { ...LIVE, traderId: 'T2' }, { ...LIVE, status: 'FILLED' }]);
  if (options.repo === undefined) await repo.upsertMany(orders);
  const store = new ColumnarStore({ capacity: 16 });
  for await (const batch of repo.loadAll()) store.appendBatch(batch);
  const engine = new QueryEngine(store, { maxViews: 16, maxBytes: 1 << 26, maxBlockRows: 10_000 });
  const runtime = new LiveRuntime({
    store,
    engine,
    repo,
    bus,
    log,
    flushMs: 100,
    writeBehindMs: 500,
    maxTrackedBlocks: 20,
    retryMs: 1_000,
  });
  return { bus, repo, store, engine, runtime, orders };
}

const update = (orderId: string, order: Partial<Order>): OrderEvent => ({ type: 'UPDATE', order: { orderId, ...order }, ts: 1 });
const tick = (bid: number, ask: number): PriceTick => ({ pair: 'EURUSD', bid, ask, ts: 1 });

async function persisted(repo: InMemoryOrderRepository): Promise<Order[]> {
  const out: Order[] = [];
  for await (const b of repo.loadAll()) out.push(...b);
  return out;
}

function client(runtime: LiveRuntime, engine: QueryEngine): { sent: ServerMsg[]; session: ClientSession; ask: () => void } {
  const sent: ServerMsg[] = [];
  const connection = { send: (f: Frame): void => void sent.push(jsonCodec.decode(f) as ServerMsg), close: vi.fn(), bufferedAmount: 0 };
  const session = new ClientSession(connection as unknown as Connection, { engine: () => engine, live: () => runtime, log });
  session.handleFrame(JSON.stringify({ t: 'hello', traderId: 'ALL', codec: 'json', clientId: 'c' }));
  const ask = (): void =>
    session.handleFrame(
      JSON.stringify({
        t: 'getRows',
        reqId: 1,
        req: { startRow: 0, endRow: 10, rowGroupCols: [], valueCols: [], groupKeys: [], sortModel: [], filterModel: null },
      }),
    );
  return { sent, session, ask };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('LiveRuntime', () => {
  it('attaches to the bus on start, not before', async () => {
    vi.useFakeTimers();
    const r = await rig();
    const consume = vi.spyOn(r.bus, 'consume');
    expect(consume).not.toHaveBeenCalled();
    r.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(consume).toHaveBeenCalledWith({ stream: 'ORDERS', durable: 'blotter-server', subject: 'orders.events' }, expect.any(Function));
    expect(r.runtime.isAttached).toBe(true);
    await r.runtime.stop();
  });

  it('applies events and ticks on each flush, patches cached views and sends clients a delta and a summary', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const r = await rig();
    r.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    const c = client(r.runtime, r.engine);
    c.ask();
    c.sent.length = 0;

    await r.bus.publish('prices.EURUSD', tick(1.0899, 1.0901));
    await r.bus.publish('orders.events', update(r.orders[0]?.orderId ?? '', { filledQty: 900_000, remainingQty: 100_000, numFills: 7 }));
    expect(r.store.orderAt(0).filledQty).toBe(400_000);
    await vi.advanceTimersByTimeAsync(100);
    expect(r.store.orderAt(0)).toMatchObject({ filledQty: 900_000, marketMid: 1.09, numFills: 7 });

    const delta = c.sent.find((m) => m.t === 'delta');
    expect(delta).toMatchObject({ t: 'delta' });
    if (delta?.t !== 'delta') throw new Error('no delta');
    const row = delta.updates[0]?.rows.find((x) => x.orderId === r.orders[0]?.orderId);
    expect(row).toMatchObject({ filledQty: 900_000, marketMid: 1.09, numFills: 7 });
    expect(c.sent.find((m) => m.t === 'summary')).toMatchObject({ t: 'summary', byStatus: { LIVE: 2, FILLED: 1 } });
    expect(r.runtime.flushStats.flushes).toBeGreaterThan(0);
    expect(r.runtime.flushStats.lastChanges).toBeGreaterThanOrEqual(0);
    await r.runtime.stop();
  });

  it('keeps a cached view equal to a fresh read after live appends', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const r = await rig();
    r.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    const c = client(r.runtime, r.engine);
    c.ask();
    const fresh = makeOrders([{}, {}, {}, { ...LIVE, createdAt: 9_999_999_999_999 }]).slice(3)[0] as Order;
    await r.bus.publish('orders.events', { type: 'NEW', order: fresh, ts: 1 });
    await vi.advanceTimersByTimeAsync(100);
    const res = r.engine.getRows('ALL', { startRow: 0, endRow: 10, rowGroupCols: [], valueCols: [], groupKeys: [], sortModel: [], filterModel: null });
    expect(res.ok && res.value.built).toBe(false);
    expect(res.ok && res.value.rows[0]?.orderId).toBe(fresh.orderId);
    const delta = c.sent.find((m) => m.t === 'delta');
    expect(delta).toMatchObject({ adds: [{ route: [], addIndex: 0 }] });
    await r.runtime.stop();
  });

  it('persists lifecycle changes through write-behind but not price-only changes', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const r = await rig();
    r.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    await r.bus.publish('prices.EURUSD', tick(1.0899, 1.0901));
    await vi.advanceTimersByTimeAsync(600);
    expect(r.runtime.writeBehind.stats.ordersWritten).toBe(0);
    expect((await persisted(r.repo))[0]?.marketMid).toBe(1.08);
    await r.bus.publish('orders.events', update(r.orders[0]?.orderId ?? '', { filledQty: 900_000, remainingQty: 100_000 }));
    await vi.advanceTimersByTimeAsync(600);
    expect(r.runtime.writeBehind.stats.ordersWritten).toBe(1);
    const stored = (await persisted(r.repo))[0];
    expect(stored).toMatchObject({ filledQty: 900_000 });
    expect(stored?.marketMid).toBe(1.09);
    await r.runtime.stop();
  });

  it('acknowledges the bus only after persisting, so a restart replays exactly what was lost (idempotent)', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const first = await rig();
    first.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    const id = first.orders[0]?.orderId ?? '';
    await first.bus.publish('orders.events', update(id, { filledQty: 500_000, remainingQty: 500_000, numFills: 4 }));
    await first.bus.publish('orders.events', update(id, { filledQty: 700_000, remainingQty: 300_000, numFills: 5 }));
    await vi.advanceTimersByTimeAsync(100);
    // Applied in memory but not yet written: "crash" here by abandoning the runtime.
    expect(first.store.orderAt(0).filledQty).toBe(700_000);
    expect((await persisted(first.repo))[0]?.filledQty).toBe(400_000);

    const second = await rig({ bus: first.bus, repo: first.repo });
    second.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(second.store.orderAt(0)).toMatchObject({ filledQty: 700_000, numFills: 5 });
    expect(second.store.size).toBe(3);
    await vi.advanceTimersByTimeAsync(600);
    expect((await persisted(second.repo))[0]).toMatchObject({ filledQty: 700_000, numFills: 5 });

    // After a persisted pass the events are acknowledged: a third start sees nothing to replay.
    const third = await rig({ bus: first.bus, repo: second.repo });
    third.runtime.start();
    await vi.advanceTimersByTimeAsync(200);
    expect(third.runtime.live.stats.eventsApplied).toBe(0);
    for (const x of [first, second, third]) await x.runtime.stop();
  });

  it('replaying a stream that includes NEW orders already persisted does not duplicate them', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const first = await rig();
    first.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    const fresh = makeOrders([{}, {}, {}, { ...LIVE }]).slice(3)[0] as Order;
    await first.bus.publish('orders.events', { type: 'NEW', order: fresh, ts: 1 });
    await vi.advanceTimersByTimeAsync(100);
    await first.runtime.writeBehind.flush();
    // Persisted and acked; now replay everything anyway from a fresh durable (as after stream loss of the consumer).
    const rows = (await persisted(first.repo)).length;
    expect(rows).toBe(4);
    const second = await rig({ bus: first.bus, repo: first.repo });
    for (const m of first.bus.streamLog('ORDERS')) second.runtime.live.enqueueEvent(m.payload as OrderEvent, () => undefined);
    second.runtime.flush();
    expect(second.store.size).toBe(4);
    await first.runtime.stop();
  });

  it('drops and acknowledges invalid events', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const r = await rig();
    r.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    await r.bus.publish('orders.events', { type: 'UPDATE', order: { filledQty: 'nope' }, ts: 1 });
    await r.bus.publish('prices.EURUSD', { nonsense: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(r.runtime.live.stats.eventsApplied).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }), 'dropped invalid order event');
    await r.runtime.stop();
  });

  it('retries attaching until the stream exists', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const r = await rig();
    const consume = vi.spyOn(r.bus, 'consume');
    consume.mockRejectedValueOnce(new Error('stream not found'));
    r.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.runtime.isAttached).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.runtime.isAttached).toBe(true);
    expect(consume).toHaveBeenCalledTimes(2);
    await r.runtime.stop();
  });

  it('publishes control.load for a preset change', async () => {
    const r = await rig();
    const seen: unknown[] = [];
    await r.bus.subscribe('control.load', (p) => seen.push(p));
    await r.runtime.setPreset('stress');
    expect(seen).toEqual([{ preset: 'stress' }]);
  });

  it('catches stale string ranks up in the background', async () => {
    const r = await rig();
    r.store.stringRank('clientOrderId');
    r.engine.getRows('ALL', { startRow: 0, endRow: 5, rowGroupCols: [], valueCols: [], groupKeys: [], sortModel: [{ colId: 'clientOrderId', sort: 'asc' }], filterModel: null });
    const fresh = makeOrders([{}, {}, {}, { ...LIVE }]).slice(3)[0] as Order;
    r.store.appendBatch([fresh]);
    expect(r.store.staleRankFields()).toContain('clientOrderId');
    await r.runtime.refreshRanks();
    expect(r.store.staleRankFields()).toEqual([]);
  });

  it('exposes summary, stats and client count to sessions', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const r = await rig();
    r.runtime.start();
    expect(r.runtime.summary('ALL').byStatus).toMatchObject({ LIVE: 2, FILLED: 1 });
    expect(r.runtime.summary('T1').liveNotionalUsd).toBe(1_080_000);
    expect(r.runtime.stats()).toHaveProperty('rssMb');
    expect(r.runtime.clientCount).toBe(0);
    const c = client(r.runtime, r.engine);
    expect(r.runtime.clientCount).toBe(1);
    c.session.dispose();
    expect(r.runtime.clientCount).toBe(0);
    await r.runtime.stop();
  });

  it('survives a session that throws during a flush', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const r = await rig();
    r.runtime.start();
    const c = client(r.runtime, r.engine);
    vi.spyOn(c.session, 'onFlush').mockImplementation(() => {
      throw new Error('boom');
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'session flush failed');
    await r.runtime.stop();
  });
});
