import { CURRENCY_PAIRS, MemoryBus, BUCKETS, jsonCodec, type Order, type PriceTick, type ServerMsg } from '@apeiron/logos';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryEngine, type EngineOptions } from '../query/engine.js';
import { ClientSession } from '../session.js';
import { ColumnarStore } from '../store/columnar-store.js';
import { ensureBuckets, publishRecord } from '../testing/bucket.js';
import { makeOrders } from '../testing/orders.js';
import type { Connection, Frame } from '../transport.js';
import { defaultWarmViews, type WarmEntry } from '../warmup.js';
import { LiveRuntime, type Stage, type WatchHandoff } from './runtime.js';

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
  store: ColumnarStore;
  engine: QueryEngine;
  runtime: LiveRuntime;
  orders: Order[];
  handoff: WatchHandoff;
  stages: Stage[];
  onFatal: ReturnType<typeof vi.fn>;
  /** Publishes the order service's next record for the order at `index`: the stored order with `patch`, one version up. */
  publish(index: number, patch: Partial<Order>): Promise<void>;
};

type RigOptions = {
  bus?: MemoryBus;
  rows?: Partial<Order>[];
  engine?: Partial<EngineOptions>;
  flushBudgetMs?: number;
  priceWaitMs?: number;
};

/** A loaded store (as the snapshot would leave it) and a runtime continuing from an open watch on the bucket. */
async function rig(options: RigOptions = {}): Promise<Rig> {
  const bus = options.bus ?? new MemoryBus();
  await ensureBuckets(bus);
  const orders = makeOrders(options.rows ?? [{ ...LIVE }, { ...LIVE, traderId: 'T2' }, { ...LIVE, status: 'FILLED' }]);
  const store = new ColumnarStore({ capacity: 16 });
  store.appendBatch(orders, orders.map(() => 1));
  const engine = new QueryEngine(store, { maxViews: 16, maxBytes: 1 << 26, maxBlockRows: 10_000, ...options.engine });
  const watch = await bus.kv(BUCKETS.orderState).watch({ updatesOnly: true });
  const handoff: WatchHandoff = { entries: watch[Symbol.asyncIterator](), watch, revision: 0 };
  const stages: Stage[] = [];
  const onFatal = vi.fn();
  const runtime = new LiveRuntime({
    store,
    engine,
    bus,
    log,
    flushMs: 100,
    maxTrackedBlocks: 20,
    retryMs: 1_000,
    flushBudgetMs: options.flushBudgetMs,
    snapshot: handoff,
    priceWaitMs: options.priceWaitMs ?? 500,
    onStage: (finished) => stages.push(finished),
    onFatal,
  });
  const versions = new Map<string, number>();
  const publish = async (index: number, patch: Partial<Order>): Promise<void> => {
    const base = orders[index] as Order;
    const v = (versions.get(base.orderId) ?? 1) + 1;
    versions.set(base.orderId, v);
    const current = store.orderAt(store.rowIndexOf(base.orderId) as number);
    await publishRecord(bus, { ...current, ...patch }, v);
  };
  return { bus, store, engine, runtime, orders, handoff, stages, onFatal, publish };
}

const tick = (bid: number, ask: number): PriceTick => ({ pair: 'EURUSD', bid, ask, ts: 1 });

const allPairs = (bus: MemoryBus, ts: number): Promise<void[]> =>
  Promise.all(CURRENCY_PAIRS.map((pair) => bus.publish(`prices.${pair}`, { pair, bid: 1, ask: 1.0002, ts })));

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

afterEach(() => {
  vi.useRealTimers();
});

describe('LiveRuntime', () => {
  it('attaches to the bus on start, not before', async () => {
    vi.useFakeTimers();
    const r = await rig();
    const subscribe = vi.spyOn(r.bus, 'subscribe');
    expect(subscribe).not.toHaveBeenCalled();
    r.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(subscribe.mock.calls.map((c) => c[0]).sort()).toEqual(['control.state', 'orders.answers', 'prices.*']);
    expect(r.runtime.isAttached).toBe(true);
    await r.runtime.stop();
  });

  it('does not consume the order stream: it holds no position in it', async () => {
    vi.useFakeTimers();
    const r = await rig();
    const consume = vi.spyOn(r.bus, 'consume');
    r.runtime.start();
    await vi.advanceTimersByTimeAsync(500);
    expect(consume).not.toHaveBeenCalled();
    await r.runtime.stop();
  });

  it('caches the preset hermes reports on control.state and tells new clients in welcome and summary', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const r = await rig();
    r.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.runtime.preset()).toBeNull();
    const before = client(r.runtime, r.engine);
    expect(before.sent.find((m) => m.t === 'welcome')).toMatchObject({ preset: null });
    await r.bus.publish('control.state', { preset: 'stress' });
    expect(r.runtime.preset()).toBe('stress');
    await r.bus.publish('control.state', { preset: 'bogus' });
    expect(r.runtime.preset()).toBe('stress');
    const after = client(r.runtime, r.engine);
    expect(after.sent.find((m) => m.t === 'welcome')).toMatchObject({ preset: 'stress' });
    after.ask();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(after.sent.find((m) => m.t === 'summary')).toMatchObject({ preset: 'stress' });
    await r.bus.publish('control.state', { preset: 'medium' });
    expect(r.runtime.preset()).toBe('medium');
    await r.runtime.stop();
  });

  it('applies records and ticks on each flush, patches cached views and sends clients a delta and a summary', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const r = await rig();
    r.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    const c = client(r.runtime, r.engine);
    c.ask();
    c.sent.length = 0;

    await r.bus.publish('prices.EURUSD', tick(1.0899, 1.0901));
    await r.publish(0, { filledQty: 900_000, remainingQty: 100_000, numFills: 7 });
    expect(r.store.orderAt(0).filledQty).toBe(400_000);
    await vi.advanceTimersByTimeAsync(100);
    expect(r.store.orderAt(0)).toMatchObject({ filledQty: 900_000, marketMid: 1.09, numFills: 7 });
    expect(r.store.versionAt(0)).toBe(2);

    const delta = c.sent.find((m) => m.t === 'delta');
    expect(delta).toMatchObject({ t: 'delta' });
    if (delta?.t !== 'delta') throw new Error('no delta');
    const row = delta.updates[0]?.rows.find((x) => x.orderId === r.orders[0]?.orderId);
    expect(row).toMatchObject({ filledQty: 900_000, marketMid: 1.09, numFills: 7 });
    expect(c.sent.find((m) => m.t === 'summary')).toMatchObject({ t: 'summary', byStatus: { LIVE: 2, FILLED: 1 } });
    expect(r.runtime.flushStats.flushes).toBeGreaterThan(0);
    expect(r.runtime.live.appliedRevision).toBeGreaterThan(0);
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
    await publishRecord(r.bus, fresh);
    await vi.advanceTimersByTimeAsync(100);
    const res = r.engine.getRows('ALL', { startRow: 0, endRow: 10, rowGroupCols: [], valueCols: [], groupKeys: [], sortModel: [], filterModel: null });
    expect(res.ok && res.value.built).toBe(false);
    expect(res.ok && res.value.rows[0]?.orderId).toBe(fresh.orderId);
    const delta = c.sent.find((m) => m.t === 'delta');
    expect(delta).toMatchObject({ adds: [{ route: [], addIndex: 0 }] });
    await r.runtime.stop();
  });

  it('ignores a record at or below the version a row holds, and counts it', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const r = await rig();
    r.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    await publishRecord(r.bus, { ...(r.orders[0] as Order), filledQty: 1 }, 1);
    await publishRecord(r.bus, { ...(r.orders[0] as Order), filledQty: 2 }, 1);
    await vi.advanceTimersByTimeAsync(100);
    expect(r.store.orderAt(0).filledQty).toBe(400_000);
    expect(r.runtime.ignoredCounts).toMatchObject({ stale: 2 });
    await r.runtime.stop();
  });

  it('ignores delete markers and unreadable values, and counts them', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const r = await rig();
    r.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    const kv = r.bus.kv(BUCKETS.orderState);
    await kv.put('JUNK', { nonsense: true });
    await publishRecord(r.bus, r.orders[2] as Order, 1);
    await kv.delete(r.orders[2]?.orderId ?? '');
    await vi.advanceTimersByTimeAsync(100);
    expect(r.store.size).toBe(3);
    expect(r.store.orderAt(2).status).toBe('FILLED');
    expect(r.runtime.ignoredCounts).toMatchObject({ delete: 1, invalid: 1 });
    await r.runtime.stop();
  });

  it('reports applied and ignored records to the metrics', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const metrics = { flush: vi.fn(), eventAge: vi.fn(), ingest: vi.fn(), command: vi.fn(), views: vi.fn(), rebuild: vi.fn(), records: vi.fn(), startup: vi.fn() };
    const r = await rig();
    const runtime = new LiveRuntime({ store: r.store, engine: r.engine, bus: r.bus, log, flushMs: 100, maxTrackedBlocks: 20, snapshot: r.handoff, priceWaitMs: 100, metrics });
    runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    await r.publish(0, { filledQty: 5 });
    await publishRecord(r.bus, r.orders[1] as Order, 1);
    await vi.advanceTimersByTimeAsync(150);
    expect(metrics.records).toHaveBeenCalledWith({ applied: 1, ignored: { stale: 1, delete: 0, invalid: 0 } });
    expect(metrics.ingest).toHaveBeenCalledWith('order');
    await runtime.stop();
  });

  it('does not touch the order stream or any database when records arrive', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const r = await rig();
    r.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    const publish = vi.spyOn(r.bus, 'publish');
    await r.publish(0, { filledQty: 900_000 });
    await vi.advanceTimersByTimeAsync(300);
    expect(publish).not.toHaveBeenCalled();
    await r.runtime.stop();
  });

  it('retries attaching until the bus accepts the subscriptions', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const r = await rig();
    const subscribe = vi.spyOn(r.bus, 'subscribe');
    subscribe.mockRejectedValueOnce(new Error('not connected'));
    r.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.runtime.isAttached).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.runtime.isAttached).toBe(true);
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

describe('LiveRuntime startup stages', () => {
  it('goes catch-up, prices, then ready: caught up once the entries pending behind the latest are few', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const r = await rig();
    await allPairs(r.bus, 5);
    await r.publish(0, { filledQty: 5 });
    r.runtime.start();
    expect(r.runtime.stage).toBe('catchup');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.runtime.stage).toBe('catchup');
    await vi.advanceTimersByTimeAsync(300);
    expect(r.runtime.stage).toBe('ready');
    expect(r.stages).toEqual(['catchup', 'prices', 'warmup']);
    expect(r.store.orderAt(0).filledQty).toBe(5);
    await r.runtime.stop();
  });

  it('is caught up when nothing arrives for a moment', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const r = await rig();
    await allPairs(r.bus, 5);
    r.runtime.start();
    await vi.advanceTimersByTimeAsync(200);
    expect(r.runtime.stage).toBe('catchup');
    await vi.advanceTimersByTimeAsync(400);
    expect(['prices', 'ready']).toContain(r.runtime.stage);
    await r.runtime.stop();
  });

  it('takes the last price of every pair before it is ready, so open orders are priced from the start', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const r = await rig();
    await r.bus.publish('prices.EURUSD', { pair: 'EURUSD', bid: 1.0899, ask: 1.0901, ts: 7 });
    await r.bus.publish('prices.EURUSD', { pair: 'EURUSD', bid: 1.0999, ask: 1.1001, ts: 8 });
    r.runtime.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.runtime.live.lastTickTs()).toMatchObject({ EURUSD: 8 });
    expect(r.store.orderAt(0).marketMid).toBe(1.1);
    await r.runtime.stop();
  });

  it('waits for a price for every pair, then goes on without the missing ones and says which', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const r = await rig({ priceWaitMs: 800 });
    await r.bus.publish('prices.EURUSD', tick(1.0899, 1.0901));
    r.runtime.start();
    await vi.advanceTimersByTimeAsync(600);
    expect(r.runtime.stage).toBe('prices');
    await vi.advanceTimersByTimeAsync(800);
    expect(r.runtime.stage).toBe('ready');
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ missing: expect.arrayContaining(['GBPUSD']) }), 'starting without a price for some pairs');
    await r.runtime.stop();
  });

  it('is ready as soon as every pair has a price', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const r = await rig({ priceWaitMs: 60_000 });
    await allPairs(r.bus, 3);
    r.runtime.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.runtime.stage).toBe('ready');
    await r.runtime.stop();
  });

  it('warms the views it is given after the prices, before it is ready, and records how long it took', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const r = await rig();
    await allPairs(r.bus, 5);
    const entry = defaultWarmViews()[1] as WarmEntry;
    const warm = new LiveRuntime({ store: r.store, engine: r.engine, bus: r.bus, log, flushMs: 100, maxTrackedBlocks: 20, snapshot: r.handoff, priceWaitMs: 100, warmViews: [entry], warmRounds: 2 });
    const seen: string[] = [];
    const getRows = vi.spyOn(r.engine, 'getRows').mockImplementation(function (this: QueryEngine, ...args) {
      seen.push(warm.stage);
      return QueryEngine.prototype.getRows.apply(this, args);
    });
    expect(warm.warmup).toBeNull();
    warm.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(warm.stage).toBe('ready');
    expect(getRows).toHaveBeenCalledTimes(2 * 5);
    expect(new Set(seen)).toEqual(new Set(['warmup']));
    expect(warm.warmup).toMatchObject({ views: 1, requests: 10, failures: 0 });
    await warm.stop();
  });

  it('stops being ready when told to drain, and stays draining', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const r = await rig();
    await allPairs(r.bus, 5);
    r.runtime.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.runtime.stage).toBe('ready');
    r.runtime.drain();
    expect(r.runtime.stage).toBe('draining');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.runtime.stage).toBe('draining');
    await r.runtime.stop();
  });

  it('does not become ready if it was told to drain while starting up', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const r = await rig({ priceWaitMs: 800 });
    r.runtime.start();
    await vi.advanceTimersByTimeAsync(400);
    r.runtime.drain();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(r.runtime.stage).toBe('draining');
    await r.runtime.stop();
  });

  it('reports the end of the order-state watch as fatal: the store can no longer be kept current', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const r = await rig();
    r.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    await r.handoff.watch.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.onFatal).toHaveBeenCalledWith('the order-state watch ended');
    await r.runtime.stop();
  });

  it('does not report a fatal error when it is stopped on purpose', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const r = await rig();
    r.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    await r.runtime.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.onFatal).not.toHaveBeenCalled();
  });
});

describe('LiveRuntime deferred view maintenance', () => {
  it('rebuilds a view that a tick could not patch after the tick, then tells its clients to refresh every route', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const r = await rig({ engine: { structuralRebuildThreshold: 0 } });
    r.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    const c = client(r.runtime, r.engine);
    c.ask();
    c.sent.length = 0;
    const view = [...r.engine.views()][0];
    expect(view?.refs).toBe(1);

    // createdAt is the default sort key, so this is a structural change.
    await r.publish(0, { createdAt: 5 });
    await vi.advanceTimersByTimeAsync(110);
    expect(view?.rebuildPending).toBe(false);
    expect(r.engine.stats().rebuilds).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    const dirty = c.sent.find((m) => m.t === 'delta' && m.dirtyRoutes.length > 0);
    expect(dirty).toMatchObject({ dirtyRoutes: [[]] });
    await r.runtime.stop();
  });

  it('rebuilds a pending view at most once a second', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const r = await rig({ engine: { structuralRebuildThreshold: 0 } });
    r.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    const c = client(r.runtime, r.engine);
    c.ask();
    for (let i = 0; i < 6; i++) {
      await r.publish(0, { createdAt: 100 + i });
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(r.engine.stats().rebuilds).toBeLessThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.engine.stats().rebuilds).toBeLessThanOrEqual(2);
    expect(r.engine.stats().rebuilds).toBeGreaterThanOrEqual(1);
    await r.runtime.stop();
  });

  it('with no flush budget, views carry their changes and are patched once the budget allows', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const r = await rig({ flushBudgetMs: 0 });
    r.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    const c = client(r.runtime, r.engine);
    c.ask();
    await r.publish(0, { createdAt: 7 });
    await vi.advanceTimersByTimeAsync(100);
    const view = [...r.engine.views()][0];
    expect(view!.appliedSeq).toBeLessThan(r.engine.tickSeq);
    expect(r.engine.stats().lastApply.deferred).toBe(1);
    expect(r.engine.hasDeferredWork()).toBe(true);
    await r.runtime.stop();
  });
});
