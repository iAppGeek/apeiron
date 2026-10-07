import { MemoryBus, applyCommand, getCodec, parseOrderCommand, jsonCodec, type ClientMsg, type CodecName, type Order, type ServerMsg } from '@apeiron/logos';
import { InMemoryOrderRepository } from '@apeiron/mnemosyne';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { type RawData } from 'ws';
import { buildServer, type BlotterServer } from './server.js';
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

async function start(bus: MemoryBus, repo = new InMemoryOrderRepository()): Promise<{ server: BlotterServer; wsUrl: string; base: string }> {
  if (!(await repo.isSeeded())) await repo.upsertMany(ROWS);
  const s = await buildServer({
    repo,
    bus,
    logLevel: 'silent',
    storeCapacity: 64,
    flushMs: 20,
    writeBehindMs: 30,
    maxTrackedBlocks: 20,
    summaryIntervalMs: 50,
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
  it('consumes the stream only after the store has loaded', async () => {
    const bus = new MemoryBus();
    const consume = vi.spyOn(bus, 'consume');
    const repo = new InMemoryOrderRepository();
    await repo.upsertMany(ROWS);
    const original = repo.loadAll.bind(repo);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    repo.loadAll = async function* (size?: number) {
      await gate;
      yield* original(size);
    };
    const { server: s, base } = await start(bus, repo);
    const loading = s.load();
    await new Promise((r) => setTimeout(r, 30));
    expect(consume).not.toHaveBeenCalled();
    expect((await fetch(`${base}/health`)).status).toBe(503);
    release();
    await loading;
    await vi.waitFor(() => expect(consume).toHaveBeenCalledTimes(1));
    const health = (await (await fetch(`${base}/health`)).json()) as { live?: { attached: boolean } };
    await vi.waitFor(async () => {
      const h = (await (await fetch(`${base}/health`)).json()) as { live?: { attached: boolean } };
      expect(h.live?.attached).toBe(true);
    });
    expect(health).toHaveProperty('status', 'ok');
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
    await bus.publish('orders.events', { type: 'NEW', order: fresh, ts: 1 });
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

  it('persists a lifecycle change to the repository within the write-behind interval', async () => {
    const bus = new MemoryBus();
    const repo = new InMemoryOrderRepository();
    const { server: s } = await start(bus, repo);
    await s.load();
    await bus.publish('orders.events', { type: 'UPDATE', order: { orderId: 'T0000001', status: 'FILLED', filledQty: 1_000_000, remainingQty: 0 }, ts: 1 });
    await vi.waitFor(async () => {
      const out: Order[] = [];
      for await (const b of repo.loadAll()) out.push(...b);
      expect(out.find((o) => o.orderId === 'T0000001')).toMatchObject({ status: 'FILLED', filledQty: 1_000_000 });
    });
  });

  it('exposes flush, lag and write-behind figures on /debug/lag and resets them on request', async () => {
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

  it('works without a bus (read-only), refusing control', async () => {
    const repo = new InMemoryOrderRepository();
    await repo.upsertMany(ROWS);
    const s = await buildServer({ repo, logLevel: 'silent', storeCapacity: 64 });
    server = s;
    await s.app.listen({ port: 0, host: '127.0.0.1' });
    await s.load();
    expect(s.runtime()).toBeNull();
    const addr = s.app.server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    const c = await connect(`ws://127.0.0.1:${port}/ws`);
    c.send({ t: 'hello', traderId: 'ALL', codec: 'json', clientId: 'ro' });
    await c.until((m) => m.t === 'welcome');
    c.send({ t: 'control', reqId: 1, preset: 'stress' });
    await expect(c.until((m) => m.t === 'error')).resolves.toMatchObject({ code: 'NOT_IMPLEMENTED' });
  });
});

/** Stands in for hermes: consumes `orders.commands`, applies them with the shared lifecycle and answers on `orders.events`. */
async function fakeHermes(bus: MemoryBus, held: Order[], options: { silent?: boolean } = {}): Promise<{ seen: string[] }> {
  const seen: string[] = [];
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
    void bus.publish('orders.events', { type: 'UPDATE', order: { orderId: cmd.orderId, ...result.changes }, ts: Date.now(), commandId: cmd.commandId });
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
    const repo = new InMemoryOrderRepository();
    await repo.upsertMany(ROWS);
    const s = await buildServer({ repo, bus, logLevel: 'silent', storeCapacity: 64, flushMs: 20, writeBehindMs: 30, commandTimeoutMs: 150 });
    server = s;
    await s.app.listen({ port: 0, host: '127.0.0.1' });
    await s.load();
    const addr = s.app.server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    const c = await connect(`ws://127.0.0.1:${port}/ws`);
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
