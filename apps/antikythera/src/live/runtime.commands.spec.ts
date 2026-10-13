import { BUCKETS, MemoryBus, jsonCodec, type ClientMsg, type Order, type OrderCommandReply, type OrderCommandRequest, type ServerMsg } from '@apeiron/logos';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryEngine } from '../query/engine.js';
import { ClientSession } from '../session.js';
import { ColumnarStore } from '../store/columnar-store.js';
import { ensureBuckets, publishRecord } from '../testing/bucket.js';
import { makeOrders } from '../testing/orders.js';
import type { Connection, Frame } from '../transport.js';
import { LiveRuntime } from './runtime.js';
import { testEntitlements } from '../testing/users.js';

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

type Rig = { bus: MemoryBus; store: ColumnarStore; runtime: LiveRuntime; engine: QueryEngine; requests: OrderCommandRequest[]; serve: (reply: (r: OrderCommandRequest) => OrderCommandReply | Promise<OrderCommandReply>) => Promise<void> };

async function rig(options: { commandTimeoutMs?: number; ackWaitVMs?: number } = {}): Promise<Rig> {
  const bus = new MemoryBus();
  await ensureBuckets(bus);
  const orders = makeOrders([{ ...LIVE }, { ...LIVE, status: 'PAUSED' }, { ...LIVE, status: 'FILLED' }]);
  const store = new ColumnarStore({ capacity: 16 });
  store.appendBatch(orders, orders.map(() => 1));
  const watch = await bus.kv(BUCKETS.orderState).watch({ updatesOnly: true });
  const engine = new QueryEngine(store, { maxViews: 16, maxBytes: 1 << 26, maxBlockRows: 10_000 });
  const runtime = new LiveRuntime({
    store,
    engine,
    bus,
    log,
    flushMs: 10,
    maxTrackedBlocks: 20,
    commandTimeoutMs: options.commandTimeoutMs ?? 1_000,
    ackWaitVMs: options.ackWaitVMs ?? 300,
    snapshot: { entries: watch[Symbol.asyncIterator](), watch, revision: 0 },
  });
  runtime.start();
  await vi.waitFor(() => expect(runtime.isAttached).toBe(true));
  const requests: OrderCommandRequest[] = [];
  const serve: Rig['serve'] = async (reply) => {
    await bus.serve('orders.cmd', async (p) => {
      requests.push(p as OrderCommandRequest);
      return reply(p as OrderCommandRequest);
    });
  };
  return { bus, store, runtime, engine, requests, serve };
}

type Client = { sent: ServerMsg[]; session: ClientSession; send: (m: ClientMsg) => void };

function client(r: Rig, clientId = 'c1'): Client {
  const sent: ServerMsg[] = [];
  const connection = { send: (f: Frame): void => {
      const m = jsonCodec.decode(f) as ServerMsg;
      if (m.t !== 'summary') sent.push(m);
    }, close: vi.fn(), bufferedAmount: 0 };
  const session = new ClientSession(connection as unknown as Connection, { entitlements: testEntitlements, engine: () => r.engine, live: () => r.runtime, log });
  const send = (m: ClientMsg): void => session.handleFrame(JSON.stringify(m));
  send({ t: 'hello', userId: 'SUPERVISOR', traderId: 'ALL', codec: 'json', clientId });
  send({
    t: 'getRows',
    reqId: 1,
    req: { startRow: 0, endRow: 10, rowGroupCols: [], valueCols: [], groupKeys: [], sortModel: [], filterModel: null },
  });
  sent.length = 0;
  return { sent, session, send };
}

const command = (reqId: number, orderId: string, action: 'CANCEL' | 'PAUSE' | 'RESUME'): ClientMsg => ({ t: 'command', reqId, orderId, action });
const types = (c: Client): string[] => c.sent.filter((m) => m.t !== 'summary').map((m) => (m.t === 'error' ? `error:${m.code}` : m.t));

/** The order service's record for the order, one version up, with the patch applied. */
async function publishNext(r: Rig, orderId: string, patch: Partial<Order>): Promise<number> {
  const row = r.store.rowIndexOf(orderId) as number;
  const v = r.store.versionAt(row) + 1;
  await publishRecord(r.bus, { ...r.store.orderAt(row), ...patch }, v);
  return v;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('LiveRuntime commands', () => {
  it('sends the command to the order service with its id, and acks after the store holds the version it replied with', async () => {
    const r = await rig();
    await r.serve(async (req) => ({ ok: true, v: await publishNext(r, req.orderId, { status: 'PAUSED' }) }));
    const c = client(r, 'client-9');
    c.send(command(7, 'T0000001', 'PAUSE'));
    expect(r.runtime.commands.size).toBe(1);
    await vi.waitFor(() => expect(types(c)).toContain('ack'));
    expect(r.requests).toEqual([{ commandId: 'client-9:7', userId: 'SUPERVISOR', orderId: 'T0000001', kind: 'action', action: 'PAUSE' }]);
    expect(types(c)).toEqual(['delta', 'ack']);
    const delta = c.sent.find((m) => m.t === 'delta') as Extract<ServerMsg, { t: 'delta' }>;
    expect(delta.updates[0]?.rows[0]).toMatchObject({ orderId: 'T0000001', status: 'PAUSED' });
    expect(c.sent.at(-1)).toEqual({ t: 'ack', reqId: 7 });
    expect(r.runtime.commands.size).toBe(0);
    await r.runtime.stop();
  });

  it('holds the ack until the record arrives, then sends it', async () => {
    const r = await rig();
    await r.serve(() => ({ ok: true, v: 2 }));
    const c = client(r);
    c.send(command(8, 'T0000001', 'PAUSE'));
    await vi.waitFor(() => expect(r.requests).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(types(c)).toEqual([]);
    expect(r.runtime.commands.size).toBe(1);
    await publishNext(r, 'T0000001', { status: 'PAUSED' });
    await vi.waitFor(() => expect(types(c)).toEqual(['delta', 'ack']));
    await r.runtime.stop();
  });

  it('acks anyway when the record has not arrived by the wait limit', async () => {
    const r = await rig({ ackWaitVMs: 80 });
    await r.serve(() => ({ ok: true, v: 9 }));
    const c = client(r);
    c.send(command(9, 'T0000001', 'PAUSE'));
    await vi.waitFor(() => expect(types(c)).toEqual(['ack']));
    expect(r.runtime.commands.size).toBe(0);
    await r.runtime.stop();
  });

  it('applies the record for every client but acks only the one that asked', async () => {
    const r = await rig();
    await r.serve(async (req) => ({ ok: true, v: await publishNext(r, req.orderId, { status: 'PAUSED' }) }));
    const asker = client(r, 'a');
    const watcher = client(r, 'b');
    asker.send(command(1, 'T0000001', 'PAUSE'));
    await vi.waitFor(() => expect(types(asker)).toEqual(['delta', 'ack']));
    expect(types(watcher)).toEqual(['delta']);
    await r.runtime.stop();
  });

  it('passes a refusal through with its code and message, and a venue refusal as INVALID_TRANSITION', async () => {
    const r = await rig();
    const replies: OrderCommandReply[] = [
      { ok: false, code: 'UNKNOWN_ORDER', message: 'Order NOPE does not exist' },
      { ok: false, code: 'INVALID_TRANSITION', message: 'Cannot cancel an order that is FILLED' },
      { ok: false, code: 'VENUE_REJECT', message: 'Cannot resume an order that is LIVE' },
      { ok: false, code: 'TIMEOUT', message: 'venue did not answer' },
    ];
    await r.serve(() => replies.shift() as OrderCommandReply);
    const c = client(r);
    c.send(command(1, 'NOPE', 'CANCEL'));
    await vi.waitFor(() => expect(c.sent).toHaveLength(1));
    c.send(command(2, 'T0000003', 'CANCEL'));
    await vi.waitFor(() => expect(c.sent).toHaveLength(2));
    c.send(command(3, 'T0000001', 'RESUME'));
    await vi.waitFor(() => expect(c.sent).toHaveLength(3));
    c.send(command(4, 'T0000001', 'PAUSE'));
    await vi.waitFor(() => expect(c.sent).toHaveLength(4));
    expect(c.sent).toEqual([
      { t: 'error', reqId: 1, code: 'UNKNOWN_ORDER', message: 'Order NOPE does not exist' },
      { t: 'error', reqId: 2, code: 'INVALID_TRANSITION', message: 'Cannot cancel an order that is FILLED' },
      { t: 'error', reqId: 3, code: 'INVALID_TRANSITION', message: 'Cannot resume an order that is LIVE' },
      { t: 'error', reqId: 4, code: 'INTERNAL', message: 'command timed out' },
    ]);
    expect(r.runtime.commands.size).toBe(0);
    await r.runtime.stop();
  });

  it('errors with INTERNAL "command timed out" when the order service does not answer', async () => {
    const r = await rig({ commandTimeoutMs: 80 });
    const c = client(r);
    c.send(command(3, 'T0000001', 'CANCEL'));
    await vi.waitFor(() => expect(c.sent).toEqual([{ t: 'error', reqId: 3, code: 'INTERNAL', message: 'command timed out' }]));
    expect(r.runtime.commands.size).toBe(0);
    await r.runtime.stop();
  });

  it('errors with INTERNAL when the reply cannot be read', async () => {
    const r = await rig();
    await r.bus.serve('orders.cmd', () => ({ nonsense: true }));
    const c = client(r);
    c.send(command(5, 'T0000001', 'PAUSE'));
    await vi.waitFor(() => expect(c.sent).toEqual([{ t: 'error', reqId: 5, code: 'INTERNAL', message: 'Unreadable reply to the command' }]));
    await r.runtime.stop();
  });

  it('forgets a session`s pending commands when it closes, and sends it nothing', async () => {
    const r = await rig();
    let release: (reply: OrderCommandReply) => void = () => undefined;
    await r.serve(() => new Promise<OrderCommandReply>((resolve) => (release = resolve)));
    const c = client(r);
    c.send(command(4, 'T0000001', 'PAUSE'));
    await vi.waitFor(() => expect(r.requests).toHaveLength(1));
    expect(r.runtime.commands.size).toBe(1);
    c.session.dispose();
    expect(r.runtime.commands.size).toBe(0);
    release({ ok: true, v: 2 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(c.sent).toEqual([]);
    await r.runtime.stop();
  });

  it('refuses a request id that is already in flight', async () => {
    const r = await rig();
    await r.serve(() => new Promise<OrderCommandReply>(() => undefined));
    const c = client(r);
    c.send(command(1, 'T0000001', 'PAUSE'));
    c.send(command(1, 'T0000002', 'CANCEL'));
    expect(c.sent).toEqual([{ t: 'error', reqId: 1, code: 'BAD_REQUEST', message: 'Command c1:1 is already in progress' }]);
    await vi.waitFor(() => expect(r.requests).toHaveLength(1));
    await r.runtime.stop();
  });
});
