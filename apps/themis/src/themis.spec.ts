import { MemoryBus, type ExecReport, type OrderCommandReply, type VenueInstruction, type KvBucket, type Order, type OrderStateRecord, type Submission, type SubmitReply } from '@apeiron/logos';
import { InMemoryOrderRepository, toStoredOrder, type OrderRepository } from '@apeiron/mnemosyne';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from './log.js';
import { historyOrders, openOrders } from './testing.js';
import { ThemisMetrics } from './metrics.js';
import { SUBMISSION_MEMORY_MS, startThemis, type Themis } from './themis.js';

const log = createLogger('error', () => undefined);
const history = historyOrders(5);
const open = openOrders;

async function seeded(rows: Order[] = [...history, ...open(3)]): Promise<InMemoryOrderRepository> {
  const repo = new InMemoryOrderRepository();
  await repo.upsertMany(rows.map(toStoredOrder));
  return repo;
}

const options = (bus: MemoryBus, repo: OrderRepository, extra: { metrics?: ThemisMetrics; venueTimeoutMs?: number; now?: () => number } = {}): Parameters<typeof startThemis>[0] => ({
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

describe('startThemis: reference levels', () => {
  it('answers ref.mids with the latest market mid per pair among the open orders, and the reference level for the rest', async () => {
    const bus = new MemoryBus();
    const rows = [...history, ...open(3)].map((o, i): Order => (i === 5 ? { ...o, currencyPair: 'EURUSD', marketMid: 1.2345, lastUpdateTime: 9_999_999 } : o));
    const themis = await startThemis(options(bus, await seeded(rows)));
    const mids = (await bus.request('ref.mids', {}, 100)) as Record<string, number>;
    expect(Object.keys(mids)).toHaveLength(20);
    expect(mids['EURUSD']).toBe(1.2345);
    expect(mids['USDTRY']).toBe(32);
    await themis.stop();
  });

  it('stops answering when it stops', async () => {
    const bus = new MemoryBus();
    const themis = await startThemis(options(bus, await seeded()));
    await themis.stop();
    await expect(bus.request('ref.mids', {}, 50)).rejects.toThrow(/No responders/);
  });
});

const submission = (key: string, overrides: Partial<Omit<Order, 'orderId'>> = {}): Submission => {
  const { orderId: _id, ...order } = open(1)[0] as Order;
  return { clientOrderId: key, order: { ...order, clientOrderId: key, traderId: 'T1', account: 'T1-ACC-1', status: 'LIVE', filledQty: 0, remainingQty: order.orderQty, numFills: 0, ...overrides } };
};
const ask = (bus: MemoryBus, payload: unknown): Promise<SubmitReply> => bus.request('orders.submit', payload, 1_000) as Promise<SubmitReply>;
const QUOTE = { bid: 1.0799, ask: 1.0801 };

describe('startThemis: submissions', () => {
  it('accepts a submission: stores it at v = 1 with the next id, publishes it, and replies only once that is done', async () => {
    const bus = new MemoryBus();
    const repo = await seeded();
    const themis = await startThemis(options(bus, repo));
    const before = await repo.maxOrderId();
    const reply = await ask(bus, submission('c-1'));
    expect(reply).toMatchObject({ ok: true, v: 1 });
    if (!reply.ok) throw new Error('rejected');
    expect(reply.orderId > (before as string)).toBe(true);
    // The reply came after the commit: the database and the bucket already hold it.
    expect((await repo.loadOpen()).some((s) => s.order.orderId === reply.orderId)).toBe(true);
    expect(await kvRecord(bus.kv('ORDER_STATE'), reply.orderId)).toMatchObject({ v: 1, execSeq: 0, order: { clientOrderId: 'c-1', traderId: 'T1' } });
    expect(themis.status().openOrders).toBe(4);
    await themis.stop();
  });

  it('gives consecutive submissions ascending ids, and continues above the highest id after a restart', async () => {
    const bus = new MemoryBus();
    const repo = await seeded();
    const first = await startThemis(options(bus, repo));
    const ids: string[] = [];
    for (const key of ['a', 'b', 'c']) ids.push(((await ask(bus, submission(key))) as { orderId: string }).orderId);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(3);
    await first.stop();
    const second = await startThemis(options(bus, repo));
    const next = ((await ask(bus, submission('d'))) as { orderId: string }).orderId;
    expect(next > (ids[2] as string)).toBe(true);
    await second.stop();
  });

  it('publishes new orders to the bucket in ascending id order, however fast they arrive', async () => {
    const bus = new MemoryBus();
    const themis = await startThemis(options(bus, await seeded()));
    const keys: string[] = [];
    const watch = await bus.kv('ORDER_STATE').watch({ updatesOnly: true });
    void (async (): Promise<void> => {
      for await (const e of watch) keys.push(e.key);
    })();
    const replies = await Promise.all(['p', 'q', 'r', 's', 't'].map((k) => ask(bus, submission(k))));
    await watch.close();
    const ids = replies.map((r) => (r as { orderId: string }).orderId);
    expect(ids).toEqual([...ids].sort());
    expect(keys).toEqual(ids);
    await themis.stop();
  });

  it('is idempotent on clientOrderId, including across a restart', async () => {
    const bus = new MemoryBus();
    const repo = await seeded();
    const first = await startThemis(options(bus, repo));
    const one = (await ask(bus, submission('same'))) as { orderId: string };
    const again = (await ask(bus, submission('same'))) as { orderId: string };
    expect(again.orderId).toBe(one.orderId);
    const count = await repo.count();
    await first.stop();
    const second = await startThemis(options(bus, repo));
    expect(((await ask(bus, submission('same'))) as { orderId: string }).orderId).toBe(one.orderId);
    expect(await repo.count()).toBe(count);
    await second.stop();
  });

  it('forgets a clientOrderId after 24 hours, and still remembers a newer one', async () => {
    const bus = new MemoryBus();
    let t = Date.now();
    const themis = await startThemis(options(bus, await seeded(), { now: () => t }));
    const old = (await ask(bus, submission('old'))) as { orderId: string };
    t += SUBMISSION_MEMORY_MS - 1_000;
    const recent = (await ask(bus, submission('recent'))) as { orderId: string };
    t += 2_000;
    const renewed = (await ask(bus, submission('old'))) as { orderId: string };
    expect(renewed.orderId).not.toBe(old.orderId);
    expect(((await ask(bus, submission('recent'))) as { orderId: string }).orderId).toBe(recent.orderId);
    await themis.stop();
  });

  it.each([
    ['a terminal status', submission('x', { status: 'FILLED' })],
    ['an unknown trader', submission('x', { traderId: 'T9' })],
    ['an account of another trader', submission('x', { account: 'T2-ACC-1' })],
    ['a zero quantity', submission('x', { orderQty: 0 })],
    ['something that is not a submission', { nonsense: true }],
  ])('refuses %s and stores nothing', async (_name, payload) => {
    const bus = new MemoryBus();
    const repo = await seeded();
    const metrics = new ThemisMetrics();
    const themis = await startThemis(options(bus, repo, { metrics }));
    const count = await repo.count();
    expect(await ask(bus, payload)).toMatchObject({ ok: false, code: 'INVALID_SUBMISSION' });
    expect(await repo.count()).toBe(count);
    expect(await metrics.render()).toContain('themis_submissions_total{result="invalid"} 1');
    await themis.stop();
  });
});

describe('startThemis: execution reports', () => {
  async function running(): Promise<{ bus: MemoryBus; repo: InMemoryOrderRepository; themis: Themis; state: KvBucket; metrics: ThemisMetrics; id: string }> {
    const bus = new MemoryBus();
    const repo = await seeded();
    const metrics = new ThemisMetrics();
    const themis = await startThemis(options(bus, repo, { metrics }));
    const id = (await repo.loadOpen())[0]?.order.orderId as string;
    return { bus, repo, themis, state: bus.kv('ORDER_STATE'), metrics, id };
  }
  const fill = (orderId: string, execSeq: number, qty: number, ts = 1_000): ExecReport => ({ type: 'FILL', orderId, execSeq, qty, price: 1.0802, ts, ...QUOTE });

  it('applies a fill: a new version with the market snapshot of the report, stored and published before it is acknowledged', async () => {
    const { bus, repo, themis, state, id } = await running();
    await bus.publish('exec.reports', fill(id, 1, 250_000));
    await themis.flush();
    const stored = (await repo.loadOpen()).find((s) => s.order.orderId === id);
    expect(stored).toMatchObject({ v: 2, execSeq: 1, order: { filledQty: 250_000, numFills: 1, marketBid: 1.0799, marketAsk: 1.0801, lastUpdateTime: 1_000 } });
    expect(await kvRecord(state, id)).toMatchObject({ v: 2, execSeq: 1, srcTs: 1_000 });
    const redelivered = vi.fn();
    await bus.consume({ stream: 'EXEC', durable: 'themis-exec', subject: 'exec.reports' }, redelivered);
    expect(redelivered).not.toHaveBeenCalled();
    await themis.stop();
  });

  it('ignores a report whose execSeq is not above the last accepted one, counts it, and accepts gaps', async () => {
    const { bus, repo, themis, metrics, id } = await running();
    await bus.publish('exec.reports', fill(id, 4, 100));
    await bus.publish('exec.reports', fill(id, 4, 100));
    await bus.publish('exec.reports', fill(id, 2, 100));
    await bus.publish('exec.reports', fill(id, 9, 100));
    await themis.flush();
    expect((await repo.loadOpen()).find((s) => s.order.orderId === id)).toMatchObject({ v: 3, execSeq: 9, order: { numFills: 2, filledQty: 200 } });
    const text = await metrics.render();
    expect(text).toContain('themis_exec_reports_total{type="FILL",result="applied"} 2');
    expect(text).toContain('themis_exec_reports_total{type="FILL",result="duplicate"} 2');
    await themis.stop();
  });

  it('clamps a fill larger than what remains, counts it, and completes the order', async () => {
    const { bus, repo, themis, metrics, id, state } = await running();
    const qty = (await repo.loadOpen())[0]?.order.orderQty as number;
    await bus.publish('exec.reports', fill(id, 1, qty * 3));
    await themis.flush();
    expect(await kvRecord(state, id)).toMatchObject({ v: 2, order: { status: 'FILLED', filledQty: qty, remainingQty: 0, unrealisedPnlUsd: 0 } });
    expect(await metrics.render()).toContain('themis_fills_clamped_total 1');
    // A finished order leaves memory once its last version is committed.
    expect(themis.status().openOrders).toBe(2);
    await themis.stop();
  });

  it('rejects a fill on a paused order: nothing changes but the counter, which is stored so the report is not replayed', async () => {
    const { bus, repo, themis, metrics, id } = await running();
    await bus.publish('exec.reports', { type: 'PAUSED', orderId: id, execSeq: 1, instrId: 'c:1', ts: 1_000 });
    await bus.publish('exec.reports', fill(id, 2, 100));
    await themis.flush();
    const stored = (await repo.loadOpen()).find((s) => s.order.orderId === id);
    expect(stored).toMatchObject({ v: 2, execSeq: 2, order: { status: 'PAUSED', filledQty: 0 } });
    expect(await metrics.render()).toContain('themis_exec_reports_total{type="FILL",result="rejected"} 1');
    const redelivered = vi.fn();
    await bus.consume({ stream: 'EXEC', durable: 'themis-exec', subject: 'exec.reports' }, redelivered);
    expect(redelivered).not.toHaveBeenCalled();
    await themis.stop();
  });

  it('applies activation, pause, resume and cancel in order', async () => {
    const { bus, repo, themis, state } = await running();
    const pending = (await repo.loadOpen())[1]?.order.orderId as string;
    await repo.upsertMany([{ order: { ...(await repo.loadOpen())[1]?.order as Order, status: 'PENDING_START' }, v: 1, execSeq: 0 }]);
    await themis.stop();
    const again = await startThemis(options(bus, repo));
    await bus.publish('exec.reports', { type: 'ACTIVATED', orderId: pending, execSeq: 1, ts: 10 });
    await bus.publish('exec.reports', { type: 'PAUSED', orderId: pending, execSeq: 2, instrId: 'c:1', ts: 20 });
    await bus.publish('exec.reports', { type: 'RESUMED', orderId: pending, execSeq: 3, instrId: 'c:2', ts: 50 });
    await bus.publish('exec.reports', { type: 'CANCELLED', orderId: pending, execSeq: 4, reason: 'TRADER', ts: 60, ...QUOTE });
    await again.flush();
    expect(await kvRecord(state, pending)).toMatchObject({ v: 5, execSeq: 4, order: { status: 'CANCELLED', completedAt: 60 } });
    await again.stop();
  });

  it('acknowledges and ignores reports for an unknown order and unreadable reports', async () => {
    const { bus, themis, metrics } = await running();
    await bus.publish('exec.reports', fill('ALG00000000', 1, 100));
    await bus.publish('exec.reports', { type: 'FILL', nonsense: true });
    await themis.flush();
    const text = await metrics.render();
    expect(text).toContain('themis_exec_reports_total{type="FILL",result="unknown"} 1');
    expect(text).toContain('themis_exec_reports_total{type="invalid",result="invalid"} 1');
    const redelivered = vi.fn();
    await bus.consume({ stream: 'EXEC', durable: 'themis-exec', subject: 'exec.reports' }, redelivered);
    expect(redelivered).not.toHaveBeenCalled();
    await themis.stop();
  });

  it('loses no report when it dies before committing: a new instance replays them from its durable consumer', async () => {
    const bus = new MemoryBus();
    const rows = [...history, ...open(3)];
    const reference = await seeded(rows);
    await (await startThemis(options(bus, reference))).stop();
    const stuck = await seeded(rows);
    stuck.upsertMany = (): Promise<void> => new Promise(() => undefined);
    const dying = await startThemis(options(bus, stuck));
    const id = (await reference.loadOpen())[0]?.order.orderId as string;
    await bus.publish('exec.reports', fill(id, 1, 111));
    await bus.publish('exec.reports', fill(id, 2, 222));
    await dying.stop({ flush: false });
    const revived = await startThemis(options(bus, reference));
    await revived.flush();
    expect((await reference.loadOpen()).find((s) => s.order.orderId === id)).toMatchObject({ v: 3, execSeq: 2, order: { filledQty: 333, numFills: 2 } });
    await revived.stop();
  });
});

describe('startThemis: orders.query.open', () => {
  const collect = async (bus: MemoryBus): Promise<{ chunks: { chunk: number; of: number; records: OrderStateRecord[] }[]; reply: unknown }> => {
    const chunks: { chunk: number; of: number; records: OrderStateRecord[] }[] = [];
    await bus.subscribe('inbox.test', (p) => chunks.push(p as never));
    const reply = await bus.request('orders.query.open', { inbox: 'inbox.test' }, 1_000);
    return { chunks, reply };
  };

  it('sends the open orders (not the finished ones) with their versions to the inbox, then replies with the counts', async () => {
    const bus = new MemoryBus();
    const themis = await startThemis(options(bus, await seeded()));
    const { chunks, reply } = await collect(bus);
    expect(reply).toEqual({ chunks: 1, count: 3 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ chunk: 0, of: 1 });
    expect(chunks[0]?.records.map((r) => r.order.status)).toEqual(['LIVE', 'LIVE', 'LIVE']);
    expect(chunks[0]?.records[0]).toMatchObject({ v: 1, execSeq: expect.any(Number) });
    await themis.stop();
  });

  it('chunks a large set into messages of at most 500 records', async () => {
    const bus = new MemoryBus();
    const themis = await startThemis(options(bus, await seeded([...history, ...open(1_203)])));
    const { chunks, reply } = await collect(bus);
    expect(reply).toEqual({ chunks: 3, count: 1203 });
    expect(chunks.map((c) => c.records.length)).toEqual([500, 500, 203]);
    expect(chunks.map((c) => [c.chunk, c.of])).toEqual([[0, 3], [1, 3], [2, 3]]);
    await themis.stop();
  });

  it('includes an order submitted a moment ago and leaves out one that has just finished', async () => {
    const bus = new MemoryBus();
    const repo = await seeded();
    const themis = await startThemis(options(bus, repo));
    const { orderId } = (await ask(bus, submission('q'))) as { orderId: string };
    const doneId = (await repo.loadOpen())[0]?.order.orderId as string;
    await bus.publish('exec.reports', { type: 'CANCELLED', orderId: doneId, execSeq: 1, reason: 'TRADER', ts: 5, ...QUOTE });
    const { chunks } = await collect(bus);
    const ids = chunks.flatMap((c) => c.records.map((r) => r.order.orderId));
    expect(ids).toContain(orderId);
    expect(ids).not.toContain(doneId);
    await themis.stop();
  });

  it('refuses a request without a usable inbox', async () => {
    const bus = new MemoryBus();
    const themis = await startThemis(options(bus, await seeded()));
    await expect(bus.request('orders.query.open', {}, 100)).rejects.toThrow(/inbox/);
    await expect(bus.request('orders.query.open', { inbox: 'bad subject!' }, 100)).rejects.toThrow(/inbox/);
    await themis.stop();
  });
});

describe('startThemis: commands', () => {
  const request = (bus: MemoryBus, orderId: string, action: 'CANCEL' | 'PAUSE' | 'RESUME', n = 1): Promise<OrderCommandReply> =>
    bus.request('orders.cmd', { commandId: `c:${n}`, userId: 'TRADER1', orderId, kind: 'action', action }, 5_000) as Promise<OrderCommandReply>;

  /** A stand-in for the venue: it records the instructions it is sent. */
  async function venue(bus: MemoryBus): Promise<VenueInstruction[]> {
    const got: VenueInstruction[] = [];
    await bus.consume({ stream: 'VENUE', durable: 'hermes-venue', subject: 'exec.commands' }, (p, _s, ack) => {
      got.push(p as VenueInstruction);
      ack();
    });
    return got;
  }

  async function running(extra: { venueTimeoutMs?: number } = {}): Promise<{ bus: MemoryBus; repo: InMemoryOrderRepository; themis: Themis; metrics: ThemisMetrics; instructions: VenueInstruction[]; id: string; other: string }> {
    const bus = new MemoryBus();
    const repo = await seeded();
    const metrics = new ThemisMetrics();
    const themis = await startThemis(options(bus, repo, { metrics, ...extra }));
    const instructions = await venue(bus);
    const open = await repo.loadOpen();
    return { bus, repo, themis, metrics, instructions, id: open[0]?.order.orderId as string, other: open[1]?.order.orderId as string };
  }

  const paused = (orderId: string, execSeq: number, instrId: string): ExecReport => ({ type: 'PAUSED', orderId, execSeq, instrId, ts: 2_000 });

  it('instructs the venue, waits for its report, and replies with the new version once that is stored and published', async () => {
    const { bus, repo, themis, instructions, id } = await running();
    const reply = request(bus, id, 'PAUSE');
    await vi.waitFor(() => expect(instructions).toHaveLength(1));
    expect(instructions[0]).toMatchObject({ instrId: 'c:1', orderId: id, action: 'PAUSE' });
    expect(themis.debug()).toMatchObject({ pendingInstructions: 1 });
    await bus.publish('exec.reports', paused(id, 1, 'c:1'));
    expect(await reply).toEqual({ ok: true, v: 2 });
    expect((await repo.loadOpen()).find((s) => s.order.orderId === id)).toMatchObject({ v: 2, order: { status: 'PAUSED' } });
    expect(((await bus.kv('ORDER_STATE').get(id))?.value as OrderStateRecord).v).toBe(2);
    expect(themis.debug()).toMatchObject({ pendingInstructions: 0 });
    await themis.stop();
  });

  it('refuses what the lifecycle forbids, and an unknown order, without troubling the venue', async () => {
    const { bus, themis, instructions, id, metrics } = await running();
    expect(await request(bus, id, 'RESUME', 1)).toEqual({ ok: false, code: 'INVALID_TRANSITION', message: 'Cannot resume an order that is LIVE' });
    expect(await request(bus, 'ALG00000000', 'CANCEL', 2)).toEqual({ ok: false, code: 'UNKNOWN_ORDER', message: 'Order ALG00000000 does not exist' });
    expect(instructions).toEqual([]);
    expect(await metrics.render()).toContain('themis_commands_total{kind="action",result="INVALID_TRANSITION"} 1');
    await themis.stop();
  });

  it('refuses a finished order as an invalid transition', async () => {
    const { bus, themis, id } = await running();
    await bus.publish('exec.reports', { type: 'CANCELLED', orderId: id, execSeq: 1, reason: 'TRADER', ts: 5, ...QUOTE });
    await themis.flush();
    expect(await request(bus, id, 'PAUSE')).toMatchObject({ ok: false, code: 'INVALID_TRANSITION', message: 'Cannot pause an order that is CANCELLED' });
    await themis.stop();
  });

  it('does not send a second instruction for an order that is waiting for the venue, but does for another order', async () => {
    const { bus, themis, instructions, id, other } = await running();
    const first = request(bus, id, 'PAUSE', 1);
    await vi.waitFor(() => expect(instructions).toHaveLength(1));
    expect(await request(bus, id, 'CANCEL', 2)).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
    const second = request(bus, other, 'CANCEL', 3);
    await vi.waitFor(() => expect(instructions).toHaveLength(2));
    await bus.publish('exec.reports', paused(id, 1, 'c:1'));
    await bus.publish('exec.reports', { type: 'CANCELLED', orderId: other, execSeq: 1, instrId: 'c:3', reason: 'TRADER', ts: 3, ...QUOTE });
    expect(await first).toMatchObject({ ok: true });
    expect(await second).toMatchObject({ ok: true });
    await themis.stop();
  });

  it('answers VENUE_REJECT with the venue’s message and leaves the order alone, even when the venue could not number its report', async () => {
    const { bus, repo, themis, instructions, id } = await running();
    const reply = request(bus, id, 'PAUSE');
    await vi.waitFor(() => expect(instructions).toHaveLength(1));
    await bus.publish('exec.reports', { type: 'VENUE_REJECT', orderId: id, execSeq: 1, instrId: 'c:1', message: 'order already completed', ts: 9 });
    expect(await reply).toEqual({ ok: false, code: 'VENUE_REJECT', message: 'order already completed' });
    await themis.flush();
    expect((await repo.loadOpen()).find((s) => s.order.orderId === id)).toMatchObject({ order: { status: 'LIVE' } });
    await themis.stop();
  });

  it('answers INVALID_TRANSITION when the venue’s report is one the rules refuse', async () => {
    const { bus, themis, instructions, id } = await running();
    await bus.publish('exec.reports', paused(id, 1, 'earlier'));
    await themis.flush();
    const reply = request(bus, id, 'CANCEL');
    // The order is PAUSED now, so CANCEL is allowed; the venue then reports a PAUSE, which cannot apply to a paused order.
    await vi.waitFor(() => expect(instructions).toHaveLength(1));
    await bus.publish('exec.reports', paused(id, 2, 'c:1'));
    expect(await reply).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
    await themis.stop();
  });

  it('answers TIMEOUT when the venue says nothing, frees the order, and still applies a late report without answering twice', async () => {
    const { bus, themis, instructions, id, repo } = await running({ venueTimeoutMs: 60 });
    const reply = await request(bus, id, 'PAUSE');
    expect(reply).toMatchObject({ ok: false, code: 'TIMEOUT' });
    expect(instructions).toHaveLength(1);
    expect(themis.debug()).toMatchObject({ pendingInstructions: 0 });
    await bus.publish('exec.reports', paused(id, 1, 'c:1'));
    await themis.flush();
    expect((await repo.loadOpen()).find((s) => s.order.orderId === id)).toMatchObject({ order: { status: 'PAUSED' } });
    const next = request(bus, id, 'RESUME', 2);
    await vi.waitFor(() => expect(instructions).toHaveLength(2));
    await bus.publish('exec.reports', { type: 'RESUMED', orderId: id, execSeq: 2, instrId: 'c:2', ts: 3_000 });
    expect(await next).toMatchObject({ ok: true });
    await themis.stop();
  });

  it('answers TIMEOUT at once when the instruction cannot be sent', async () => {
    const { bus, themis, id } = await running();
    const original = bus.publish.bind(bus);
    vi.spyOn(bus, 'publish').mockImplementation((subject, payload) => (subject === 'exec.commands' ? Promise.reject(new Error('nats down')) : original(subject, payload)));
    expect(await request(bus, id, 'PAUSE')).toEqual({ ok: false, code: 'TIMEOUT', message: 'Could not reach the venue' });
    expect(themis.debug()).toMatchObject({ pendingInstructions: 0 });
    await themis.stop();
  });

  const roundedPct = (filled: number, qty: number): number => Math.round((filled / qty) * 10_000) / 100;
  const amendRequest = (orderId: string, changes: Record<string, unknown>, n = 9): Record<string, unknown> => ({ commandId: `c:${n}`, userId: 'TRADER1', orderId, kind: 'amend', changes });

  it('amends an order directly: a new version with the quantity-derived fields recomputed, stored and published before the reply', async () => {
    const { bus, repo, themis, id } = await running();
    const before = (await repo.loadOpen()).find((s) => s.order.orderId === id) as { v: number; order: Order };
    const orderQty = before.order.orderQty * 2;
    const reply = await bus.request('orders.cmd', amendRequest(id, { orderQty, urgency: 'HIGH' }), 1_000);
    expect(reply).toEqual({ ok: true, v: before.v + 1 });
    const stored = (await repo.loadOpen()).find((s) => s.order.orderId === id);
    expect(stored).toMatchObject({ v: before.v + 1, order: { orderQty, urgency: 'HIGH', remainingQty: orderQty - before.order.filledQty } });
    expect(stored?.order.pctComplete).toBe(roundedPct(before.order.filledQty, orderQty));
    expect(stored?.order.notionalUsd).toBeCloseTo(before.order.notionalUsd * 2, 1);
    expect(await kvRecord(bus.kv('ORDER_STATE'), id)).toMatchObject({ v: before.v + 1, order: { orderQty, urgency: 'HIGH' } });
    expect(bus.streamLog('VENUE')).toHaveLength(0);
    await themis.stop();
  });

  it('refuses an amend that breaks a rule, changing nothing', async () => {
    const { bus, repo, themis, metrics, id } = await running();
    await bus.publish('exec.reports', { type: 'FILL', orderId: id, execSeq: 1, qty: 250_000, price: 1.0802, ts: 1_000, ...QUOTE });
    await themis.flush();
    const before = (await repo.loadOpen()).find((s) => s.order.orderId === id) as { v: number; order: Order };
    expect(before.order.filledQty).toBe(250_000);
    const refusals = await Promise.all([
      bus.request('orders.cmd', amendRequest(id, { orderQty: 100_000 }, 1), 1_000),
      bus.request('orders.cmd', amendRequest(id, { limitPrice: 1.123456789 }, 2), 1_000),
      bus.request('orders.cmd', amendRequest(id, { endTime: 1 }, 3), 1_000),
      bus.request('orders.cmd', amendRequest(id, { urgency: before.order.urgency }, 4), 1_000),
      bus.request('orders.cmd', amendRequest('NOPE', { urgency: 'LOW' }, 5), 1_000),
    ]);
    expect(refusals).toMatchObject([
      { ok: false, code: 'INVALID_AMEND' },
      { ok: false, code: 'INVALID_AMEND' },
      { ok: false, code: 'INVALID_AMEND' },
      { ok: false, code: 'INVALID_AMEND', message: 'Nothing to change' },
      { ok: false, code: 'UNKNOWN_ORDER' },
    ]);
    expect((await repo.loadOpen()).find((s) => s.order.orderId === id)?.v).toBe(before.v);
    const text = await metrics.render();
    expect(text).toContain('themis_commands_total{kind="amend",result="INVALID_AMEND"} 4');
    expect(text).toContain('themis_commands_total{kind="amend",result="UNKNOWN_ORDER"} 1');
    await themis.stop();
  });

  it('refuses to amend an order that is no longer working', async () => {
    const { bus, themis } = await running();
    const done = historyOrders(1)[0] as Order;
    expect(done.status === 'FILLED' || done.status === 'CANCELLED').toBe(true);
    expect(await bus.request('orders.cmd', amendRequest(done.orderId, { urgency: 'LOW' }), 1_000)).toMatchObject({
      ok: false,
      code: 'INVALID_TRANSITION',
      message: `Cannot amend an order that is ${done.status}`,
    });
    await themis.stop();
  });

  it('rejects a request it cannot read', async () => {
    const { bus, themis } = await running();
    await expect(bus.request('orders.cmd', { nonsense: true }, 1_000)).rejects.toThrow(/unreadable command/);
    await themis.stop();
  });

  it('times a successful command in its metrics', async () => {
    const { bus, themis, instructions, id, metrics } = await running();
    const reply = request(bus, id, 'PAUSE');
    await vi.waitFor(() => expect(instructions).toHaveLength(1));
    await bus.publish('exec.reports', paused(id, 1, 'c:1'));
    await reply;
    const text = await metrics.render();
    expect(text).toContain('themis_commands_total{kind="action",result="ok"} 1');
    expect(text).toContain('themis_command_duration_seconds_count 1');
    await themis.stop();
  });
});
