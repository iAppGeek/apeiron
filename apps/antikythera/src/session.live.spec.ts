import { jsonCodec, type ClientMsg, type LoadPreset, type Order, type ServerMsg, type SsrmRequest } from '@apeiron/logos';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_BACKPRESSURE } from './live/backpressure.js';
import { QueryEngine } from './query/engine.js';
import type { SessionMetrics } from './metrics.js';
import { ClientSession, type FlushContext, type LiveHooks } from './session.js';
import { applyOrders, applyUpdates } from './testing/apply.js';
import { makeOrders, makeStore } from './testing/orders.js';
import type { Connection, Frame } from './transport.js';

const req = (r: Partial<SsrmRequest> = {}): SsrmRequest => ({
  startRow: 0,
  endRow: 10,
  rowGroupCols: [],
  valueCols: [],
  groupKeys: [],
  sortModel: [],
  filterModel: null,
  ...r,
});
const json = (m: ClientMsg): string => JSON.stringify(m);
const decode = (f: Frame): ServerMsg => jsonCodec.decode(f) as ServerMsg;

type World = {
  store: ReturnType<typeof makeStore>;
  engine: QueryEngine;
  session: ClientSession;
  sent: ServerMsg[];
  connection: { bufferedAmount: number; close: ReturnType<typeof vi.fn> };
  live: LiveHooks;
  flush: (changes: ReturnType<typeof applyUpdates>, now: number) => void;
};

function world(overrides: Partial<LiveHooks> = {}, withLive = true, metrics?: SessionMetrics): World {
  const store = makeStore([
    { traderId: 'T1', createdAt: 1, status: 'LIVE' },
    { traderId: 'T1', createdAt: 2, status: 'LIVE' },
    { traderId: 'T2', createdAt: 3, status: 'FILLED' },
  ]);
  const engine = new QueryEngine(store, { maxViews: 8, maxBytes: 1 << 24, maxBlockRows: 1_000 });
  const sent: ServerMsg[] = [];
  const connection = {
    send: vi.fn((f: Frame) => {
      sent.push(decode(f));
    }),
    close: vi.fn(),
    bufferedAmount: 0,
  };
  const live = {
    register: vi.fn(),
    unregister: vi.fn(),
    setPreset: vi.fn(() => Promise.resolve()),
    command: vi.fn(),
    preset: vi.fn((): LoadPreset | null => null),
    summary: vi.fn(() => ({ byStatus: { PENDING_START: 0, LIVE: 2, PAUSED: 0, FILLED: 1, CANCELLED: 0 }, liveNotionalUsd: 42 })),
    stats: vi.fn(() => ({ cpu: 12.5, rssMb: 300, elLagMs: 1.5 })),
    maxTrackedBlocks: 10,
    backpressure: { softBytes: 1_000, hardBytes: 10_000, maxSlowMs: 5_000 },
    summaryIntervalMs: 1_000,
    ...overrides,
  };
  const session = new ClientSession(connection as unknown as Connection, {
    engine: () => engine,
    live: () => (withLive ? live : null),
    log: { warn: vi.fn(), error: vi.fn() },
    now: () => 1234,
    metrics,
  });
  session.handleFrame(json({ t: 'hello', traderId: 'ALL', codec: 'json', clientId: 'c1' }));
  sent.length = 0;
  const flush = (changes: ReturnType<typeof applyUpdates>, now: number): void => {
    const ctx: FlushContext = {
      cs: changes.cs,
      byView: new Map(changes.changes.map((c) => [c.view, c])),
      now,
      store,
    };
    session.onFlush(ctx);
  };
  return { store, engine, session, sent, connection, live, flush };
}

const getRows = (w: World, r: SsrmRequest = req(), reqId = 1): void => w.session.handleFrame(json({ t: 'getRows', reqId, req: r }));
const idle = (w: World): ReturnType<typeof applyUpdates> => applyUpdates(w.store, w.engine, [{ orderId: 'T0000001', marketMid: 1 }]);

describe('ClientSession commands', () => {
  it('hands a command to the runtime with the session, client id and request', () => {
    const w = world();
    w.session.handleFrame(json({ t: 'command', reqId: 4, orderId: 'T0000001', action: 'PAUSE' }));
    expect(w.live.command).toHaveBeenCalledWith(
      { owner: w.session, clientId: 'c1', reqId: 4, orderId: 'T0000001', action: 'PAUSE' },
      expect.any(Function),
    );
  });

  it('sends ack{reqId} when the command is applied', () => {
    const w = world();
    vi.mocked(w.live.command).mockImplementation((_req, settle) => settle({ ok: true }));
    w.session.handleFrame(json({ t: 'command', reqId: 4, orderId: 'T0000001', action: 'PAUSE' }));
    expect(w.sent).toEqual([{ t: 'ack', reqId: 4 }]);
  });

  it('sends error{reqId, code, message} when the command fails', () => {
    const w = world();
    vi.mocked(w.live.command).mockImplementation((_req, settle) =>
      settle({ ok: false, code: 'INVALID_TRANSITION', message: 'Cannot cancel an order that is FILLED' }),
    );
    w.session.handleFrame(json({ t: 'command', reqId: 9, orderId: 'T0000003', action: 'CANCEL' }));
    expect(w.sent).toEqual([{ t: 'error', reqId: 9, code: 'INVALID_TRANSITION', message: 'Cannot cancel an order that is FILLED' }]);
  });

  it('validates the command message before it reaches the runtime', () => {
    const w = world();
    w.session.handleFrame(json({ t: 'command', reqId: 1, orderId: 'T1', action: 'DELETE' } as unknown as ClientMsg));
    w.session.handleFrame(json({ t: 'command', reqId: 2, orderId: '', action: 'CANCEL' }));
    expect(w.live.command).not.toHaveBeenCalled();
    expect(w.sent.map((m) => (m.t === 'error' ? m.code : m.t))).toEqual(['BAD_MESSAGE', 'BAD_MESSAGE']);
  });

  it('does not send a late ack after the session has closed', () => {
    const w = world();
    let settle: (o: { ok: true }) => void = () => undefined;
    vi.mocked(w.live.command).mockImplementation((_req, s) => {
      settle = s;
    });
    w.session.handleFrame(json({ t: 'command', reqId: 4, orderId: 'T0000001', action: 'PAUSE' }));
    w.session.dispose();
    settle({ ok: true });
    expect(w.sent).toEqual([]);
  });
});

describe('ClientSession registration across a slow start', () => {
  it('joins the flush loop when the runtime comes up after the client said hello', () => {
    const w = world();
    const current: { live: LiveHooks | null } = { live: null };
    const session = new ClientSession(w.connection as unknown as Connection, {
      engine: () => w.engine,
      live: () => current.live,
      log: { warn: vi.fn(), error: vi.fn() },
      now: () => 1234,
    });
    session.handleFrame(json({ t: 'hello', traderId: 'ALL', codec: 'json', clientId: 'late' }));
    expect(w.live.register).not.toHaveBeenCalledWith(session);
    // The store finishes loading and the live runtime starts; the client's next request registers it.
    current.live = w.live;
    session.handleFrame(json({ t: 'getRows', reqId: 1, req: req() }));
    expect(w.live.register).toHaveBeenCalledWith(session);
  });
});

describe('ClientSession control and registration', () => {
  it('registers on hello and unregisters on dispose', () => {
    const w = world();
    vi.mocked(w.live.register).mockClear();
    w.session.handleFrame(json({ t: 'hello', traderId: 'T1', codec: 'json', clientId: 'c1' }));
    expect(w.live.register).toHaveBeenCalledWith(w.session);
    w.session.dispose();
    expect(w.live.unregister).toHaveBeenCalledWith(w.session);
  });

  it('forwards a control message to the bus and acknowledges once it is published', async () => {
    const w = world();
    w.session.handleFrame(json({ t: 'control', reqId: 7, preset: 'stress' }));
    expect(w.live.setPreset).toHaveBeenCalledWith('stress');
    await Promise.resolve();
    await Promise.resolve();
    expect(w.sent).toEqual([{ t: 'ack', reqId: 7 }]);
  });

  it('answers INTERNAL when publishing the control message fails', async () => {
    const w = world({ setPreset: vi.fn(() => Promise.reject(new Error('nats down'))) });
    w.session.handleFrame(json({ t: 'control', reqId: 8, preset: 'medium' }));
    await new Promise((r) => setImmediate(r));
    expect(w.sent).toEqual([{ t: 'error', reqId: 8, code: 'INTERNAL', message: 'Could not publish the load preset' }]);
  });

  it('answers NOT_IMPLEMENTED for control without a bus and for commands', () => {
    const w = world({}, false);
    w.session.handleFrame(json({ t: 'control', reqId: 1, preset: 'stress' }));
    w.session.handleFrame(json({ t: 'command', reqId: 2, orderId: 'x', action: 'CANCEL' }));
    expect(w.sent.map((m) => (m.t === 'error' ? m.code : m.t))).toEqual(['NOT_IMPLEMENTED', 'NOT_IMPLEMENTED']);
  });
});

describe('ClientSession live deltas', () => {
  it('sends a delta with the changed fields of tracked rows after a flush', () => {
    const w = world();
    getRows(w);
    w.sent.length = 0;
    w.flush(applyUpdates(w.store, w.engine, [{ orderId: 'T0000002', marketMid: 9 }]), 5_000);
    const delta = w.sent.find((m) => m.t === 'delta');
    expect(delta).toMatchObject({ t: 'delta', seq: 1, serverTs: 5_000, updates: [{ route: [], rows: [{ orderId: 'T0000002', marketMid: 9 }] }] });
  });

  it('sends nothing for a tick that changes nothing the client holds', () => {
    const w = world();
    getRows(w, req({ startRow: 0, endRow: 1 }));
    w.sent.length = 0;
    w.flush(applyUpdates(w.store, w.engine, [{ orderId: 'T0000001', marketMid: 9 }]), 5_000);
    expect(w.sent.filter((m) => m.t === 'delta')).toEqual([]);
  });

  it('does nothing before hello or without live hooks', () => {
    const w = world({}, false);
    getRows(w);
    w.sent.length = 0;
    w.flush(idle(w), 5_000);
    expect(w.sent).toEqual([]);
  });

  it('sends new orders as adds', () => {
    const w = world();
    getRows(w);
    w.sent.length = 0;
    const fresh = makeOrders([{}, {}, {}, { createdAt: 99, traderId: 'T1' }]).slice(3) as Order[];
    w.flush(applyOrders(w.store, w.engine, fresh), 5_000);
    const delta = w.sent.find((m) => m.t === 'delta');
    expect(delta).toMatchObject({ t: 'delta', adds: [{ route: [], addIndex: 0 }], rowCounts: [{ route: [], rowCount: 4 }] });
  });

  it('starts a fresh view for a new hello, forgetting what the client held', () => {
    const w = world();
    getRows(w);
    expect(w.session.trackedView).not.toBeNull();
    w.session.handleFrame(json({ t: 'hello', traderId: 'T1', codec: 'json', clientId: 'c1' }));
    expect(w.session.trackedView).toBeNull();
  });
});

describe('ClientSession summary', () => {
  it('sends a summary scoped to the trader, with the view row count and server stats, once per interval', () => {
    const w = world();
    getRows(w, req({ filterModel: { status: { filterType: 'set', values: ['LIVE'] } } }));
    w.sent.length = 0;
    w.flush(idle(w), 10_000);
    expect(w.sent.filter((m) => m.t === 'summary')).toEqual([
      {
        t: 'summary',
        byStatus: { PENDING_START: 0, LIVE: 2, PAUSED: 0, FILLED: 1, CANCELLED: 0 },
        liveNotionalUsd: 42,
        totalRows: 2,
        server: { cpu: 12.5, rssMb: 300, elLagMs: 1.5 },
        preset: null,
      },
    ]);
    expect(w.live.summary).toHaveBeenCalledWith('ALL');
    w.flush(idle(w), 10_500);
    expect(w.sent.filter((m) => m.t === 'summary')).toHaveLength(1);
    w.flush(idle(w), 11_000);
    expect(w.sent.filter((m) => m.t === 'summary')).toHaveLength(2);
  });

  it('carries the preset the runtime knows in welcome and summary', () => {
    const w = world({ preset: vi.fn((): LoadPreset | null => 'stress') });
    getRows(w);
    w.sent.length = 0;
    w.flush(idle(w), 10_000);
    expect(w.sent.find((m) => m.t === 'summary')).toMatchObject({ preset: 'stress' });
    w.session.handleFrame(json({ t: 'hello', traderId: 'ALL', codec: 'json', clientId: 'c1' }));
    expect(w.sent.find((m) => m.t === 'welcome')).toMatchObject({ preset: 'stress' });
  });

  it('counts every row of the trader before the client has asked for any', () => {
    const w = world();
    w.flush(idle(w), 10_000);
    expect(w.sent.find((m) => m.t === 'summary')).toMatchObject({ totalRows: 3 });
  });
});

describe('ClientSession backpressure', () => {
  it('holds deltas above the soft cap, keeps accumulating the latest values, and sends one conflated delta after it drains', () => {
    const w = world();
    getRows(w);
    w.sent.length = 0;
    w.connection.bufferedAmount = 5_000;
    w.flush(applyUpdates(w.store, w.engine, [{ orderId: 'T0000002', marketMid: 1 }]), 2_000);
    w.flush(applyUpdates(w.store, w.engine, [{ orderId: 'T0000002', marketMid: 2 }, { orderId: 'T0000003', marketMid: 7 }]), 2_100);
    w.flush(applyUpdates(w.store, w.engine, [{ orderId: 'T0000002', marketMid: 3, filledQty: 11 }]), 2_200);
    expect(w.sent).toEqual([]);
    w.connection.bufferedAmount = 0;
    w.flush(idle(w), 2_300);
    const deltas = w.sent.filter((m) => m.t === 'delta');
    expect(deltas).toHaveLength(1);
    const rows = deltas[0]?.t === 'delta' ? deltas[0].updates[0]?.rows : [];
    expect(rows).toEqual(
      expect.arrayContaining([
        { orderId: 'T0000002', marketMid: 3, filledQty: 11 },
        { orderId: 'T0000003', marketMid: 7 },
      ]),
    );
    expect(w.connection.close).not.toHaveBeenCalled();
  });

  it('sends held-back adds before a reply built after them, so the client does not shift the new block twice', () => {
    const w = world();
    getRows(w);
    w.sent.length = 0;
    w.connection.bufferedAmount = 5_000;
    const fresh = makeOrders([{}, {}, {}, { createdAt: 99, traderId: 'T1' }]).slice(3) as Order[];
    w.flush(applyOrders(w.store, w.engine, fresh), 2_000);
    expect(w.sent).toEqual([]);
    getRows(w, req(), 2);
    expect(w.sent.map((m) => m.t)).toEqual(['delta', 'rows']);
    expect(w.sent[0]).toMatchObject({ t: 'delta', adds: [{ route: [], addIndex: 0 }] });
    // Nothing is left to send twice once the client drains.
    w.connection.bufferedAmount = 0;
    w.sent.length = 0;
    w.flush(idle(w), 2_100);
    expect(w.sent.flatMap((m) => (m.t === 'delta' ? m.adds : []))).toEqual([]);
  });

  it('sends SLOW_CONSUMER and closes above the hard cap', () => {
    const w = world();
    getRows(w);
    w.sent.length = 0;
    w.connection.bufferedAmount = 20_000;
    w.flush(idle(w), 3_000);
    expect(w.sent).toEqual([{ t: 'error', code: 'SLOW_CONSUMER', message: 'The client is too far behind the server' }]);
    expect(w.connection.close).toHaveBeenCalledWith(1013, 'slow consumer');
    expect(w.live.unregister).toHaveBeenCalledWith(w.session);
    w.flush(idle(w), 3_100);
    expect(w.sent).toHaveLength(1);
  });

  it('closes a client that stays above the soft cap for too long, but not one that drains in time', () => {
    const w = world();
    getRows(w);
    w.connection.bufferedAmount = 5_000;
    w.flush(idle(w), 1_000);
    w.flush(idle(w), 5_900);
    expect(w.connection.close).not.toHaveBeenCalled();
    w.connection.bufferedAmount = 0;
    w.flush(idle(w), 6_000);
    w.connection.bufferedAmount = 5_000;
    w.flush(idle(w), 7_000);
    w.flush(idle(w), 11_900);
    expect(w.connection.close).not.toHaveBeenCalled();
    w.flush(idle(w), 12_000);
    expect(w.connection.close).toHaveBeenCalledTimes(1);
  });

  it('withholds the summary while held back', () => {
    const w = world();
    getRows(w);
    w.sent.length = 0;
    w.connection.bufferedAmount = 5_000;
    w.flush(idle(w), 10_000);
    expect(w.sent).toEqual([]);
  });

  it('uses sane default caps', () => {
    expect(DEFAULT_BACKPRESSURE.softBytes).toBeLessThan(DEFAULT_BACKPRESSURE.hardBytes);
  });
});

const fakeMetrics = (): SessionMetrics & { [K in keyof SessionMetrics]: ReturnType<typeof vi.fn<SessionMetrics[K]>> } => ({
  message: vi.fn(),
  getRows: vi.fn(),
  delta: vi.fn(),
  eventAgeAtSend: vi.fn(),
  error: vi.fn(),
  backpressure: vi.fn(),
});

describe('ClientSession metrics', () => {
  it('counts the messages in both directions by type and codec, with byte sizes', () => {
    const metrics = fakeMetrics();
    const w = world({}, true, metrics);
    expect(metrics.message).toHaveBeenCalledWith('out', 'welcome', 'json', expect.any(Number));
    expect(metrics.message).toHaveBeenCalledWith('in', 'hello', 'json', expect.any(Number));
    w.session.handleFrame(json({ t: 'getRows', reqId: 1, req: req({ rowGroupCols: [{ id: 'status', field: 'status' }] }) }));
    expect(metrics.message).toHaveBeenCalledWith('in', 'getRows', 'json', json({ t: 'getRows', reqId: 1, req: req({ rowGroupCols: [{ id: 'status', field: 'status' }] }) }).length);
    expect(metrics.message).toHaveBeenCalledWith('out', 'rows', 'json', expect.any(Number));
    expect(metrics.getRows).toHaveBeenCalledWith({ ms: expect.any(Number), built: true, grouped: true });
  });

  it('records invalid frames, error codes and delta sizes', () => {
    const metrics = fakeMetrics();
    const w = world({}, true, metrics);
    w.session.handleFrame('not json');
    w.session.handleFrame(json({ t: 'getRows', reqId: 1 } as unknown as ClientMsg));
    expect(metrics.message).toHaveBeenCalledWith('in', 'invalid', 'json', expect.any(Number));
    expect(metrics.error).toHaveBeenCalledWith('BAD_FRAME');
    expect(metrics.error).toHaveBeenCalledWith('BAD_MESSAGE');
    getRows(w);
    w.flush(applyUpdates(w.store, w.engine, [{ orderId: 'T0000002', marketMid: 1 }]), 2_000);
    expect(metrics.delta).toHaveBeenCalledTimes(1);
    expect(metrics.message).toHaveBeenCalledWith('out', 'delta', 'json', metrics.delta.mock.calls[0]?.[0]);
  });

  it('counts a held-back flush as soft conflation and a closed client as a slow consumer', () => {
    const metrics = fakeMetrics();
    const w = world({}, true, metrics);
    getRows(w);
    w.connection.bufferedAmount = 5_000;
    w.flush(idle(w), 2_000);
    w.flush(idle(w), 2_100);
    expect(metrics.backpressure.mock.calls.filter(([e]) => e === 'soft_conflate')).toHaveLength(2);
    expect(metrics.backpressure).not.toHaveBeenCalledWith('slow_consumer');
    w.connection.bufferedAmount = 20_000;
    w.flush(idle(w), 2_200);
    expect(metrics.backpressure).toHaveBeenCalledWith('slow_consumer');
  });

  it('reports the age of the earliest source event when a delta is sent, and puts it in the delta', () => {
    const metrics = fakeMetrics();
    const w = world({}, true, metrics);
    getRows(w);
    const out = applyUpdates(w.store, w.engine, []);
    const row = w.store.rowIndexOf('T0000002') as number;
    const { changed, prev } = w.store.updateRow(row, { marketMid: 3 });
    out.cs.noteUpdate(row, changed, prev, 1_000);
    w.flush(out, 1_100);
    const delta = w.sent.find((m) => m.t === 'delta');
    expect(delta).toMatchObject({ t: 'delta', srcTs: 1_000 });
    // The session clock reads 1234, so the event was 234 ms old when the delta went out.
    expect(metrics.eventAgeAtSend).toHaveBeenCalledWith(0.234);
  });
});
