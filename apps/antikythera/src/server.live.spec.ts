import {
  BUCKETS,
  CURRENCY_PAIRS,
  MemoryBus,
  PROJECTION_KEY,
  applyCommand,
  getCodec,
  parseOrderCommand,
  jsonCodec,
  type ClientMsg,
  type CodecName,
  type Order,
  type ServerMsg,
} from '@apeiron/logos';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { type RawData } from 'ws';
import { buildServer, type BlotterServer, type ServerOptions } from './server.js';
import { ensureBuckets, publishRecord, seedBucket } from './testing/bucket.js';
import { makeOrders } from './testing/orders.js';

const ROWS = makeOrders(
  Array.from({ length: 20 }, (_, i) => ({
    status: i < 6 ? ('LIVE' as const) : ('FILLED' as const),
    currencyPair: 'EURUSD' as const,
    side: 'BUY' as const,
    traderId: i % 2 === 0 ? 'T1' : 'T2',
    createdAt: 1_000 + i,
    orderQty: 1_000_000,
    filledQty: 100_000,
    remainingQty: 900_000,
    avgFillPrice: 1.08,
    arrivalPrice: 1.08,
    notionalUsd: 1_080_000,
  })),
);

let server: BlotterServer | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await server?.app.close();
  server = null;
  vi.useRealTimers();
});

const FAST = { priceWaitMs: 20, snapshotPollMs: 5, snapshotRetryMs: 20 } as const;

/** Seeds the bucket like the order service and gives every pair a price, unless the bus already has a projection. */
async function prepare(bus: MemoryBus): Promise<void> {
  await ensureBuckets(bus);
  if ((await bus.kv(BUCKETS.orderStateMeta).get(PROJECTION_KEY)) === null) await seedBucket(bus, ROWS);
  await Promise.all(CURRENCY_PAIRS.map((pair) => bus.publish(`prices.${pair}`, { pair, bid: 1.08, ask: 1.0802, ts: 1 })));
}

async function start(bus: MemoryBus, options: Partial<ServerOptions> = {}): Promise<{ server: BlotterServer; wsUrl: string; base: string }> {
  await prepare(bus);
  const s = await buildServer({
    bus,
    logLevel: 'silent',
    storeCapacity: 64,
    flushMs: 20,
    maxTrackedBlocks: 20,
    summaryIntervalMs: 50,
    ...FAST,
    ...options,
  });
  server = s;
  await s.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = s.app.server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { server: s, wsUrl: `ws://127.0.0.1:${port}/ws`, base: `http://127.0.0.1:${port}` };
}

type Client = { send(msg: ClientMsg): void; until(pred: (m: ServerMsg) => boolean, ms?: number): Promise<ServerMsg>; all: ServerMsg[] };

function connect(url: string, codec: CodecName = 'json'): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    sockets.push(socket);
    const all: ServerMsg[] = [];
    const listeners: (() => void)[] = [];
    socket.on('message', (raw: RawData, isBinary: boolean) => {
      const frame = isBinary ? (raw as Buffer) : raw.toString();
      all.push((isBinary ? getCodec('msgpack') : jsonCodec).decode(frame) as ServerMsg);
      for (const l of [...listeners]) l();
    });
    socket.on('error', reject);
    socket.on('open', () => {
      let current: CodecName = 'json';
      resolve({
        all,
        send: (msg): void => {
          const encoded = getCodec(current).encode(msg);
          socket.send(encoded, { binary: typeof encoded !== 'string' });
          if (msg.t === 'hello') current = codec;
        },
        until: (pred, ms = 3_000): Promise<ServerMsg> =>
          new Promise((res, rej) => {
            const check = (): boolean => {
              const hit = all.find(pred);
              if (hit !== undefined) {
                res(hit);
                return true;
              }
              return false;
            };
            if (check()) return;
            const timer = setTimeout(() => rej(new Error(`timed out; saw ${all.map((m) => m.t).join(',')}`)), ms);
            const listener = (): void => {
              if (check()) {
                clearTimeout(timer);
                listeners.splice(listeners.indexOf(listener), 1);
              }
            };
            listeners.push(listener);
          }),
      });
    });
  });
}

const rowsReq = { startRow: 0, endRow: 50, rowGroupCols: [], valueCols: [], groupKeys: [], sortModel: [], filterModel: null };

describe('live server over a real socket', () => {
  it('does not subscribe to the bus until the snapshot is loaded, and reports ok only when it is ready', async () => {
    const bus = new MemoryBus();
    const subscribe = vi.spyOn(bus, 'subscribe');
    const s = await buildServer({ bus, logLevel: 'silent', storeCapacity: 64, flushMs: 20, ...FAST });
    server = s;
    await s.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = s.app.server.address();
    const base = `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}`;
    const loading = s.load();
    await new Promise((r) => setTimeout(r, 30));
    expect(subscribe).not.toHaveBeenCalled();
    expect((await fetch(`${base}/health`)).status).toBe(503);
    await prepare(bus);
    await loading;
    expect(subscribe.mock.calls.map((c) => c[0])).toContain('prices.*');
    await vi.waitFor(async () => {
      const h = (await (await fetch(`${base}/health`)).json()) as { status: string; stage: string; live?: { attached: boolean } };
      expect(h).toMatchObject({ status: 'ok', stage: 'ready' });
      expect(h.live?.attached).toBe(true);
    });
  });

  it.each<CodecName>(['json', 'msgpack'])('delivers deltas, adds and summaries to a connected client (%s)', async (codec) => {
    const bus = new MemoryBus();
    const { server: s, wsUrl } = await start(bus);
    await s.load();
    const c = await connect(wsUrl, codec);
    c.send({ t: 'hello', traderId: 'ALL', codec, clientId: 'live-1' });
    await c.until((m) => m.t === 'welcome');
    c.send({ t: 'getRows', reqId: 1, req: rowsReq });
    const rows = await c.until((m) => m.t === 'rows');
    expect(rows).toMatchObject({ rowCount: 20 });

    await bus.publish('prices.EURUSD', { pair: 'EURUSD', bid: 1.0899, ask: 1.0901, ts: 1 });
    const delta = await c.until((m) => m.t === 'delta' && m.updates.length > 0);
    if (delta.t !== 'delta') throw new Error('unreachable');
    const priced = delta.updates[0]?.rows.find((r) => r.marketMid === 1.09);
    expect(priced).toBeDefined();
    expect(Object.keys(priced ?? {})).toEqual(expect.arrayContaining(['orderId', 'marketMid', 'unrealisedPnlUsd', 'lastUpdateTime']));

    const fresh: Order = { ...(ROWS[0] as Order), orderId: 'T0001000', createdAt: 99_999, status: 'LIVE' };
    await publishRecord(bus, fresh);
    const add = await c.until((m) => m.t === 'delta' && m.adds.length > 0);
    expect(add).toMatchObject({ adds: [{ route: [], addIndex: 0, rows: [{ orderId: 'T0001000' }] }], rowCounts: [{ route: [], rowCount: 21 }] });

    const summary = await c.until((m) => m.t === 'summary' && m.totalRows === 21);
    expect(summary).toMatchObject({ t: 'summary', byStatus: { LIVE: 7, FILLED: 14 } });
    expect(summary.t === 'summary' && summary.server.rssMb).toBeGreaterThan(0);
  });

  it('scopes the summary to the client trader', async () => {
    const bus = new MemoryBus();
    const { server: s, wsUrl } = await start(bus);
    await s.load();
    const c = await connect(wsUrl);
    c.send({ t: 'hello', traderId: 'T1', codec: 'json', clientId: 't1' });
    await c.until((m) => m.t === 'welcome');
    const summary = await c.until((m) => m.t === 'summary');
    expect(summary).toMatchObject({ byStatus: { LIVE: 3, FILLED: 7 }, totalRows: 10 });
  });

  it('forwards a control message to control.load and acknowledges it', async () => {
    const bus = new MemoryBus();
    const seen: unknown[] = [];
    await bus.subscribe('control.load', (p) => seen.push(p));
    const { server: s, wsUrl } = await start(bus);
    await s.load();
    const c = await connect(wsUrl);
    c.send({ t: 'hello', traderId: 'ALL', codec: 'json', clientId: 'c' });
    await c.until((m) => m.t === 'welcome');
    c.send({ t: 'control', reqId: 5, preset: 'stress' });
    await expect(c.until((m) => m.t === 'ack')).resolves.toEqual({ t: 'ack', reqId: 5 });
    expect(seen).toEqual([{ preset: 'stress' }]);
  });

  it('exposes flush and lag figures on /debug/lag and resets them on request', async () => {
    const bus = new MemoryBus();
    const { server: s, base } = await start(bus);
    expect(await (await fetch(`${base}/debug/lag`)).json()).toEqual({ live: false });
    await s.load();
    await new Promise((r) => setTimeout(r, 80));
    const body = (await (await fetch(`${base}/debug/lag?reset=1`)).json()) as { flush: { flushes: number }; lag: { samples: number }; clients: number };
    expect(body.flush.flushes).toBeGreaterThan(0);
    expect(body.clients).toBe(0);
    expect(body.lag).toHaveProperty('p99');
  });
});

/**
 * Stands in for hermes and the order service: consumes `orders.commands`, applies them with the shared lifecycle,
 * answers on `orders.events` and publishes the order's next record to the bucket.
 */
async function fakeHermes(bus: MemoryBus, held: Order[], options: { silent?: boolean } = {}): Promise<{ seen: string[] }> {
  const seen: string[] = [];
  const versions = new Map<string, number>();
  await bus.consume({ stream: 'ORDERS', durable: 'hermes-commands', subject: 'orders.commands' }, (payload, _subject, ack) => {
    const parsed = parseOrderCommand(payload);
    if (!parsed.ok) return ack();
    const cmd = parsed.value;
    seen.push(cmd.commandId);
    ack();
    if (options.silent === true) return;
    const order = held.find((o) => o.orderId === cmd.orderId);
    if (order === undefined) {
      void bus.publish('orders.events', { type: 'REJECT', commandId: cmd.commandId, orderId: cmd.orderId, code: 'UNKNOWN_ORDER', message: 'not held', ts: Date.now() });
      return;
    }
    const result = applyCommand(order, cmd.action, Date.now());
    if (!result.ok) {
      void bus.publish('orders.events', { type: 'REJECT', commandId: cmd.commandId, orderId: cmd.orderId, code: result.code, message: result.message, ts: Date.now() });
      return;
    }
    Object.assign(order, result.changes);
    const v = (versions.get(order.orderId) ?? 1) + 1;
    versions.set(order.orderId, v);
    void bus.publish('orders.events', { type: 'UPDATE', order: { orderId: cmd.orderId, ...result.changes }, ts: Date.now(), commandId: cmd.commandId });
    void publishRecord(bus, { ...order }, v);
  });
  return { seen };
}

describe('command path over a real socket', () => {
  const held = (): Order[] => ROWS.filter((o) => o.status === 'LIVE').map((o) => ({ ...o }));

  it.each<CodecName>(['json', 'msgpack'])('pauses and resumes an order: the delta reaches every client, the ack only the sender (%s)', async (codec) => {
    const bus = new MemoryBus();
    await fakeHermes(bus, held());
    const { server: s, wsUrl } = await start(bus);
    await s.load();
    const sender = await connect(wsUrl, codec);
    const watcher = await connect(wsUrl, codec);
    for (const [c, id] of [[sender, 'sender'], [watcher, 'watcher']] as const) {
      c.send({ t: 'hello', traderId: 'ALL', codec, clientId: id });
      await c.until((m) => m.t === 'welcome');
      c.send({ t: 'getRows', reqId: 1, req: rowsReq });
      await c.until((m) => m.t === 'rows');
    }

    sender.send({ t: 'command', reqId: 10, orderId: 'T0000001', action: 'PAUSE' });
    await sender.until((m) => m.t === 'ack' && m.reqId === 10);
    const statusDelta = (m: ServerMsg): boolean =>
      m.t === 'delta' && m.updates.some((u) => u.rows.some((r) => r.orderId === 'T0000001' && r.status === 'PAUSED'));
    await watcher.until(statusDelta);
    expect(sender.all.findIndex(statusDelta)).toBeGreaterThanOrEqual(0);
    expect(sender.all.findIndex(statusDelta)).toBeLessThan(sender.all.findIndex((m) => m.t === 'ack'));
    expect(watcher.all.some((m) => m.t === 'ack')).toBe(false);

    sender.send({ t: 'command', reqId: 11, orderId: 'T0000001', action: 'RESUME' });
    await sender.until((m) => m.t === 'ack' && m.reqId === 11);
    await watcher.until((m) => m.t === 'delta' && m.updates.some((u) => u.rows.some((r) => r.orderId === 'T0000001' && r.status === 'LIVE')));
  });

  it('answers the fast pre-check without a round trip', async () => {
    const bus = new MemoryBus();
    const hermes = await fakeHermes(bus, held());
    const { server: s, wsUrl } = await start(bus);
    await s.load();
    const c = await connect(wsUrl);
    c.send({ t: 'hello', traderId: 'ALL', codec: 'json', clientId: 'pre' });
    await c.until((m) => m.t === 'welcome');
    c.send({ t: 'command', reqId: 1, orderId: 'T0000010', action: 'CANCEL' });
    await expect(c.until((m) => m.t === 'error' && m.reqId === 1)).resolves.toMatchObject({ code: 'INVALID_TRANSITION' });
    c.send({ t: 'command', reqId: 2, orderId: 'NOPE', action: 'CANCEL' });
    await expect(c.until((m) => m.t === 'error' && m.reqId === 2)).resolves.toMatchObject({ code: 'UNKNOWN_ORDER' });
    expect(hermes.seen).toEqual([]);
  });

  it('passes hermes REJECT through as an error with its code', async () => {
    const bus = new MemoryBus();
    // Hermes does not hold T0000002, though the server's store does, so the server's pre-check passes and hermes rejects.
    await fakeHermes(bus, held().filter((o) => o.orderId !== 'T0000002'));
    const { server: s, wsUrl } = await start(bus);
    await s.load();
    const c = await connect(wsUrl);
    c.send({ t: 'hello', traderId: 'ALL', codec: 'json', clientId: 'rej' });
    await c.until((m) => m.t === 'welcome');
    c.send({ t: 'command', reqId: 3, orderId: 'T0000002', action: 'CANCEL' });
    await expect(c.until((m) => m.t === 'error' && m.reqId === 3)).resolves.toMatchObject({ code: 'UNKNOWN_ORDER', message: 'not held' });
  });

  it('cancels an order and then refuses a second cancel from the pre-check', async () => {
    const bus = new MemoryBus();
    await fakeHermes(bus, held());
    const { server: s, wsUrl } = await start(bus);
    await s.load();
    const c = await connect(wsUrl);
    c.send({ t: 'hello', traderId: 'ALL', codec: 'json', clientId: 'cx' });
    await c.until((m) => m.t === 'welcome');
    c.send({ t: 'command', reqId: 1, orderId: 'T0000003', action: 'CANCEL' });
    await c.until((m) => m.t === 'ack' && m.reqId === 1);
    c.send({ t: 'command', reqId: 2, orderId: 'T0000003', action: 'CANCEL' });
    await expect(c.until((m) => m.t === 'error' && m.reqId === 2)).resolves.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('errors with INTERNAL when hermes never answers', async () => {
    const bus = new MemoryBus();
    await fakeHermes(bus, held(), { silent: true });
    const { server: s, wsUrl } = await start(bus, { commandTimeoutMs: 150 });
    await s.load();
    const c = await connect(wsUrl);
    c.send({ t: 'hello', traderId: 'ALL', codec: 'json', clientId: 'slow' });
    await c.until((m) => m.t === 'welcome');
    c.send({ t: 'command', reqId: 1, orderId: 'T0000001', action: 'PAUSE' });
    await expect(c.until((m) => m.t === 'error' && m.reqId === 1)).resolves.toMatchObject({ code: 'INTERNAL', message: 'command timed out' });
  });

  it('forgets a pending command when the client disconnects', async () => {
    const bus = new MemoryBus();
    await fakeHermes(bus, held(), { silent: true });
    const { server: s, wsUrl } = await start(bus);
    await s.load();
    const c = await connect(wsUrl);
    c.send({ t: 'hello', traderId: 'ALL', codec: 'json', clientId: 'gone' });
    await c.until((m) => m.t === 'welcome');
    c.send({ t: 'command', reqId: 1, orderId: 'T0000001', action: 'PAUSE' });
    await vi.waitFor(() => expect(s.runtime()?.commands.size).toBe(1));
    sockets.forEach((sock) => sock.close());
    await vi.waitFor(() => expect(s.runtime()?.commands.size).toBe(0));
  });
});

describe('GET /metrics', () => {
  const sample = (text: string, series: string): number | undefined => {
    const line = text.split('\n').find((l) => l.startsWith(`${series} `));
    return line === undefined ? undefined : Number(line.slice(series.length + 1));
  };

  it('serves Prometheus text with the live measurements of a client session and a command', async () => {
    const bus = new MemoryBus();
    await fakeHermes(bus, ROWS.filter((o) => o.status === 'LIVE').map((o) => ({ ...o })));
    const { server: s, wsUrl, base } = await start(bus);
    await s.load();
    const c = await connect(wsUrl, 'msgpack');
    c.send({ t: 'hello', traderId: 'ALL', codec: 'msgpack', clientId: 'metrics-1' });
    await c.until((m) => m.t === 'welcome');
    c.send({ t: 'getRows', reqId: 1, req: rowsReq });
    await c.until((m) => m.t === 'rows');
    c.send({ t: 'command', reqId: 2, orderId: 'T0000001', action: 'PAUSE' });
    await c.until((m) => m.t === 'ack' && m.reqId === 2);
    await vi.waitFor(async () => {
      const res = await fetch(`${base}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/plain');
      const text = await res.text();
      expect(sample(text, 'apeiron_store_rows')).toBe(ROWS.length);
      expect(sample(text, 'apeiron_store_loaded')).toBe(1);
      expect(sample(text, 'apeiron_ws_connections')).toBe(1);
      expect(sample(text, 'apeiron_ws_clients{codec="msgpack"}')).toBe(1);
      expect(sample(text, 'apeiron_ws_messages_total{direction="out",type="rows",codec="msgpack"}')).toBe(1);
      expect(sample(text, 'apeiron_getrows_duration_seconds_count{temp="cold",shape="flat"}')).toBe(1);
      expect(sample(text, 'apeiron_command_duration_seconds_count{outcome="ok"}')).toBe(1);
      expect(sample(text, 'apeiron_ingest_events_total{type="command"}')).toBe(1);
      expect(sample(text, 'apeiron_ingest_events_total{type="order"}')).toBeGreaterThanOrEqual(1);
      expect(sample(text, 'apeiron_flush_duration_seconds_count')).toBeGreaterThan(0);
      expect(sample(text, 'apeiron_view_cache_views')).toBe(1);
    });
  });

  it('answers before the store has loaded, with the store marked not loaded', async () => {
    const { server: s, base } = await start(new MemoryBus());
    const text = await (await fetch(`${base}/metrics`)).text();
    expect(sample(text, 'apeiron_store_loaded')).toBe(0);
    expect(s.store.size).toBe(0);
    s.metrics.connectionOpened();
    expect(sample(await s.metrics.render(), 'apeiron_ws_connections')).toBe(1);
  });
});
