import { MemoryBus, jsonCodec, type ClientMsg, type Order, type OrderCommand, type OrderEvent, type ServerMsg } from '@apeiron/logos';
import { InMemoryOrderRepository } from '@apeiron/mnemosyne';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryEngine } from '../query/engine.js';
import { ClientSession } from '../session.js';
import { ColumnarStore } from '../store/columnar-store.js';
import { makeOrders } from '../testing/orders.js';
import type { Connection, Frame } from '../transport.js';
import { LiveRuntime } from './runtime.js';

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

type Rig = { bus: MemoryBus; runtime: LiveRuntime; engine: QueryEngine; published: OrderCommand[] };

async function rig(): Promise<Rig> {
  const bus = new MemoryBus();
  const repo = new InMemoryOrderRepository();
  await repo.upsertMany(makeOrders([{ ...LIVE }, { ...LIVE, status: 'PAUSED' }, { ...LIVE, status: 'FILLED' }]));
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
    commandTimeoutMs: 5_000,
  });
  runtime.start();
  await vi.advanceTimersByTimeAsync(0);
  const published: OrderCommand[] = [];
  await bus.subscribe('orders.commands', (p) => void published.push(p as OrderCommand));
  return { bus, runtime, engine, published };
}

type Client = { sent: ServerMsg[]; session: ClientSession; send: (m: ClientMsg) => void };

function client(r: Rig, clientId = 'c1'): Client {
  const sent: ServerMsg[] = [];
  const connection = { send: (f: Frame): void => void sent.push(jsonCodec.decode(f) as ServerMsg), close: vi.fn(), bufferedAmount: 0 };
  const session = new ClientSession(connection as unknown as Connection, { engine: () => r.engine, live: () => r.runtime, log });
  const send = (m: ClientMsg): void => session.handleFrame(JSON.stringify(m));
  send({ t: 'hello', traderId: 'ALL', codec: 'json', clientId });
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
const hermesUpdate = (commandId: string, orderId: string, order: Partial<Order>): OrderEvent => ({
  type: 'UPDATE',
  order: { orderId, ...order },
  ts: 1,
  commandId,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LiveRuntime command correlation', () => {
  it('answers an unknown order at once, without publishing', async () => {
    vi.useFakeTimers();
    const r = await rig();
    const c = client(r);
    c.send(command(5, 'NOPE', 'CANCEL'));
    expect(c.sent).toEqual([{ t: 'error', reqId: 5, code: 'UNKNOWN_ORDER', message: 'Order NOPE does not exist' }]);
    expect(r.published).toEqual([]);
    expect(r.runtime.commands.size).toBe(0);
    await r.runtime.stop();
  });

  it('pre-checks the transition against the store status, without publishing', async () => {
    vi.useFakeTimers();
    const r = await rig();
    const c = client(r);
    c.send(command(1, 'T0000003', 'CANCEL'));
    c.send(command(2, 'T0000001', 'RESUME'));
    c.send(command(3, 'T0000002', 'PAUSE'));
    expect(c.sent).toEqual([
      { t: 'error', reqId: 1, code: 'INVALID_TRANSITION', message: 'Cannot cancel an order that is FILLED' },
      { t: 'error', reqId: 2, code: 'INVALID_TRANSITION', message: 'Cannot resume an order that is LIVE' },
      { t: 'error', reqId: 3, code: 'INVALID_TRANSITION', message: 'Cannot pause an order that is PAUSED' },
    ]);
    expect(r.published).toEqual([]);
    await r.runtime.stop();
  });

  it('publishes the command with its id and acks only after the UPDATE has been applied and sent', async () => {
    vi.useFakeTimers({ now: 50_000 });
    const r = await rig();
    const c = client(r, 'client-9');
    c.send(command(7, 'T0000001', 'PAUSE'));
    expect(r.published).toEqual([
      { orderId: 'T0000001', action: 'PAUSE', requestedBy: 'client-9', ts: 50_000, commandId: 'client-9:7' },
    ]);
    expect(c.sent).toEqual([]);
    expect(r.runtime.commands.size).toBe(1);

    await r.bus.publish('orders.events', hermesUpdate('client-9:7', 'T0000001', { status: 'PAUSED' }));
    expect(c.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(types(c)).toEqual(['delta', 'ack']);
    const delta = c.sent.find((m) => m.t === 'delta') as Extract<ServerMsg, { t: 'delta' }>;
    expect(delta.updates[0]?.rows[0]).toMatchObject({ orderId: 'T0000001', status: 'PAUSED' });
    expect(c.sent.at(-1)).toEqual({ t: 'ack', reqId: 7 });
    expect(r.runtime.commands.size).toBe(0);
    await r.runtime.stop();
  });

  it('applies the UPDATE for every client but acks only the one that asked', async () => {
    vi.useFakeTimers();
    const r = await rig();
    const asker = client(r, 'a');
    const watcher = client(r, 'b');
    asker.send(command(1, 'T0000001', 'PAUSE'));
    await r.bus.publish('orders.events', hermesUpdate('a:1', 'T0000001', { status: 'PAUSED' }));
    await vi.advanceTimersByTimeAsync(100);
    expect(types(asker)).toEqual(['delta', 'ack']);
    expect(types(watcher)).toEqual(['delta']);
    await r.runtime.stop();
  });

  it('turns a REJECT into an error with hermes code and message', async () => {
    vi.useFakeTimers();
    const r = await rig();
    const c = client(r);
    c.send(command(2, 'T0000001', 'PAUSE'));
    await r.bus.publish('orders.events', {
      type: 'REJECT',
      commandId: 'c1:2',
      orderId: 'T0000001',
      code: 'INVALID_TRANSITION',
      message: 'Cannot go from PAUSED to PAUSED',
      ts: 1,
    } satisfies OrderEvent);
    expect(c.sent).toEqual([{ t: 'error', reqId: 2, code: 'INVALID_TRANSITION', message: 'Cannot go from PAUSED to PAUSED' }]);
    expect(r.runtime.commands.size).toBe(0);
    await r.runtime.stop();
  });

  it('errors with INTERNAL "command timed out" after 5 seconds, and ignores a late answer', async () => {
    vi.useFakeTimers();
    const r = await rig();
    const c = client(r);
    c.send(command(3, 'T0000001', 'CANCEL'));
    await vi.advanceTimersByTimeAsync(4_900);
    expect(types(c).filter((t) => t.startsWith('error'))).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(c.sent.filter((m) => m.t === 'error')).toEqual([{ t: 'error', reqId: 3, code: 'INTERNAL', message: 'command timed out' }]);
    c.sent.length = 0;
    await r.bus.publish('orders.events', hermesUpdate('c1:3', 'T0000001', { status: 'CANCELLED' }));
    await vi.advanceTimersByTimeAsync(100);
    expect(types(c)).toEqual(['delta']);
    await r.runtime.stop();
  });

  it('forgets a session`s pending commands when it closes', async () => {
    vi.useFakeTimers();
    const r = await rig();
    const c = client(r);
    c.send(command(4, 'T0000001', 'PAUSE'));
    c.send(command(5, 'T0000002', 'RESUME'));
    expect(r.runtime.commands.size).toBe(2);
    c.session.dispose();
    expect(r.runtime.commands.size).toBe(0);
    await r.bus.publish('orders.events', hermesUpdate('c1:4', 'T0000001', { status: 'PAUSED' }));
    await vi.advanceTimersByTimeAsync(6_000);
    expect(c.sent).toEqual([]);
    await r.runtime.stop();
  });

  it('answers INTERNAL when the command cannot be published', async () => {
    vi.useFakeTimers();
    const r = await rig();
    const original = r.bus.publish.bind(r.bus);
    vi.spyOn(r.bus, 'publish').mockImplementation((subject, payload) =>
      subject === 'orders.commands' ? Promise.reject(new Error('nats down')) : original(subject, payload),
    );
    const c = client(r);
    c.send(command(6, 'T0000001', 'PAUSE'));
    await vi.advanceTimersByTimeAsync(0);
    expect(c.sent).toEqual([{ t: 'error', reqId: 6, code: 'INTERNAL', message: 'Could not send the command' }]);
    expect(r.runtime.commands.size).toBe(0);
    await r.runtime.stop();
  });

  it('refuses a request id that is already in flight', async () => {
    vi.useFakeTimers();
    const r = await rig();
    const c = client(r);
    c.send(command(1, 'T0000001', 'PAUSE'));
    c.send(command(1, 'T0000002', 'CANCEL'));
    expect(c.sent).toEqual([{ t: 'error', reqId: 1, code: 'BAD_REQUEST', message: 'Command c1:1 is already in progress' }]);
    expect(r.published).toHaveLength(1);
    await r.runtime.stop();
  });

  it('ignores answers to commands it is not waiting for', async () => {
    vi.useFakeTimers();
    const r = await rig();
    const c = client(r);
    await r.bus.publish('orders.events', hermesUpdate('other-process:1', 'T0000001', { status: 'PAUSED' }));
    await r.bus.publish('orders.events', {
      type: 'REJECT',
      commandId: 'other-process:2',
      orderId: 'T0000001',
      code: 'UNKNOWN_ORDER',
      message: 'x',
      ts: 1,
    } satisfies OrderEvent);
    await vi.advanceTimersByTimeAsync(100);
    expect(types(c)).toEqual(['delta']);
    await r.runtime.stop();
  });
});
