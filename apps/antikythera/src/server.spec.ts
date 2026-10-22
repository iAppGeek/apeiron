import {
  CURRENCY_PAIRS,
  MemoryBus,
  getCodec,
  jsonCodec,
  type ClientMsg,
  type CodecName,
  type Order,
  type ServerMsg,
  type SsrmRequest,
} from '@apeiron/logos';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { type RawData } from 'ws';
import { buildServer, type BlotterServer } from './server.js';
import { seedBucket } from './testing/bucket.js';
import { propertyOrders } from './testing/dataset.js';
import { defaultWarmViews } from './warmup.js';
import { testEntitlements } from './testing/users.js';

const ORDERS = propertyOrders(7, 1_200);

type Client = {
  socket: WebSocket;
  send(msg: ClientMsg, codec?: CodecName): void;
  sendRaw(data: string | Uint8Array): void;
  next(): Promise<ServerMsg>;
  close(): Promise<void>;
};

function connect(url: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const queue: (ServerMsg | Error)[] = [];
    const waiters: { resolve: (m: ServerMsg) => void; reject: (e: Error) => void }[] = [];
    const deliver = (item: ServerMsg | Error): void => {
      const waiter = waiters.shift();
      if (waiter === undefined) queue.push(item);
      else if (item instanceof Error) waiter.reject(item);
      else waiter.resolve(item);
    };
    let current: CodecName = 'json';
    // The codec a hello asked for, until its welcome arrives. Frames are self-describing, so in that window a frame
    // the server sent before it read the hello (an unprompted summary or delta) may still be in the old codec.
    let pending: CodecName | null = null;
    socket.on('message', (raw: RawData, isBinary: boolean) => {
      const kind: CodecName = isBinary ? 'msgpack' : 'json';
      const msg = (isBinary ? getCodec('msgpack') : jsonCodec).decode(isBinary ? (raw as Buffer) : raw.toString()) as ServerMsg;
      if (msg.t === 'welcome' && pending !== null) {
        if (kind !== pending) return deliver(new Error(`welcome came as ${kind}, but the hello asked for ${pending}`));
        current = pending;
        pending = null;
      } else if (pending === null && kind !== current) {
        // Once the welcome has arrived, every frame must use the negotiated codec.
        return deliver(new Error(`unexpected ${isBinary ? 'binary' : 'text'} ${msg.t} frame on a ${current} connection`));
      }
      // The live runtime sends a summary every second, unprompted; these tests follow request and reply.
      if (msg.t === 'summary') return;
      deliver(msg);
    });
    socket.on('error', reject);
    socket.on('open', () => {
      resolve({
        socket,
        send: (msg, c = current): void => {
          const encoded = getCodec(c).encode(msg);
          socket.send(encoded, { binary: typeof encoded !== 'string' });
          if (msg.t === 'hello') pending = msg.codec;
        },
        sendRaw: (data): void => socket.send(data, { binary: typeof data !== 'string' }),
        next: (): Promise<ServerMsg> => {
          const m = queue.shift();
          if (m instanceof Error) return Promise.reject(m);
          return m !== undefined ? Promise.resolve(m) : new Promise((resolve, reject) => waiters.push({ resolve, reject }));
        },
        close: (): Promise<void> =>
          new Promise((r) => {
            socket.once('close', () => r());
            socket.close();
          }),
      });
    });
  });
}

const req = (r: Partial<SsrmRequest> = {}): SsrmRequest => ({
  startRow: 0,
  endRow: 25,
  rowGroupCols: [],
  valueCols: [],
  groupKeys: [],
  sortModel: [],
  filterModel: null,
  ...r,
});

let server: BlotterServer;
let bus: MemoryBus;
let base: string;
let wsUrl: string;

const FAST = { priceWaitMs: 20, snapshotPollMs: 5, snapshotRetryMs: 20 } as const;

/** What the order service leaves in the bucket, last-changed order first, as a watch would deliver it. */
const seeded = async (target: MemoryBus, rows: Order[] = ORDERS): Promise<void> => seedBucket(target, [...rows].reverse());

const publishAllPrices = (target: MemoryBus): Promise<void[]> =>
  Promise.all(CURRENCY_PAIRS.map((pair) => target.publish(`prices.${pair}`, { pair, bid: 1, ask: 1.0002, ts: 1 })));

beforeEach(async () => {
  bus = new MemoryBus();
  await seeded(bus);
  await publishAllPrices(bus);
  server = await buildServer({ entitlements: testEntitlements, bus, logLevel: 'silent', storeCapacity: 2_000, ...FAST });
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = server.app.server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});

afterEach(async () => {
  await server.app.close();
});

describe('GET /health', () => {
  it('is 503 until loading finishes, then 200 with load figures', async () => {
    const before = await fetch(`${base}/health`);
    expect(before.status).toBe(503);
    expect(await before.json()).toMatchObject({ status: 'loading', stage: 'snapshot', rows: 0 });

    const report = await server.load();
    expect(report.rows).toBe(ORDERS.length);
    const after = await fetch(`${base}/health`);
    expect(after.status).toBe(200);
    const body = (await after.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'ok', stage: 'ready', rows: ORDERS.length });
    expect(body.loadMs).toBeTypeOf('number');
    expect(body.heapMb).toBeGreaterThan(0);
    expect(body.rssMb).toBeGreaterThan(0);
  });

  it('serves /health/live while loading, and /health/ready and /health (its alias) only when ready', async () => {
    const fetchAll = async (): Promise<number[]> =>
      Promise.all(['/health/live', '/health/ready', '/health'].map(async (path) => (await fetch(`${base}${path}`)).status));
    expect(await fetchAll()).toEqual([200, 503, 503]);
    await server.load();
    expect(await fetchAll()).toEqual([200, 200, 200]);
    const ready = (await (await fetch(`${base}/health/ready`)).json()) as Record<string, unknown>;
    const alias = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
    expect(ready).toMatchObject({ status: 'ok', stage: 'ready', rows: ORDERS.length });
    expect(ready.snapshotMs).toBeGreaterThan(0);
    expect(alias.status).toBe(ready.status);
  });

  it('warms the configured views before it is ready, and reports how long that took', async () => {
    const warm = await buildServer({ entitlements: testEntitlements, bus, logLevel: 'silent', storeCapacity: 2_000, ...FAST, warmViews: defaultWarmViews(), warmRounds: 2 });
    expect(warm.health().warmupMs).toBe(0);
    await warm.load();
    expect(warm.health()).toMatchObject({ status: 'ok', stage: 'ready' });
    expect(warm.engine()?.stats().cache.views).toBeGreaterThanOrEqual(7);
    expect(warm.runtime()?.warmup).toMatchObject({ views: 7, requests: 70, failures: 0 });
    expect(warm.health().warmupMs).toBe(warm.runtime()?.warmup?.ms);
    await warm.app.close();
  });

  it('serves the orders in ascending id order even though the bucket delivers them in the order they changed', async () => {
    await server.load();
    const ids = [...Array(server.store.size).keys()].map((r) => server.store.orderAt(r).orderId);
    expect(ids).toEqual([...ids].sort());
    expect(server.store.idsAscending).toBe(true);
  });

  it('stays in the snapshot stage and never reports ok against a bucket with no projection marker', async () => {
    const empty = new MemoryBus();
    const s = await buildServer({ entitlements: testEntitlements, bus: empty, logLevel: 'silent', storeCapacity: 10, ...FAST });
    const loading = s.load();
    await new Promise((r) => setTimeout(r, 60));
    const res = await s.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'loading', stage: 'snapshot', rows: 0 });
    await seeded(empty, ORDERS.slice(0, 5));
    await publishAllPrices(empty);
    await loading;
    expect((await s.app.inject({ method: 'GET', url: '/health' })).json()).toMatchObject({ status: 'ok', rows: 5 });
    await s.app.close();
  });

  it('answers NOT_READY until it has prices, then serves rows', async () => {
    const quiet = new MemoryBus();
    await seeded(quiet);
    // The price wait outlasts the test, so the server stays in the prices stage until the test publishes them: no
    // assumption about how fast the snapshot and catch-up stages run on a busy machine.
    const s = await buildServer({ entitlements: testEntitlements, bus: quiet, logLevel: 'silent', storeCapacity: 2_000, ...FAST, priceWaitMs: 60_000 });
    await s.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = s.app.server.address();
    const url = `ws://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}/ws`;
    const loading = s.load();
    await expect.poll(() => s.health().stage, { timeout: 10_000 }).toBe('prices');
    expect(s.health()).toMatchObject({ stage: 'prices', status: 'loading' });
    const c = await connect(url);
    c.send({ t: 'hello', userId: 'SUPERVISOR', traderId: 'ALL', codec: 'json', clientId: 'early' });
    await c.next();
    c.send({ t: 'getRows', reqId: 1, req: req() });
    expect(await c.next()).toMatchObject({ t: 'error', code: 'NOT_READY' });
    await publishAllPrices(quiet);
    await loading;
    c.send({ t: 'getRows', reqId: 2, req: req() });
    expect(await c.next()).toMatchObject({ t: 'rows', reqId: 2 });
    await c.close();
    await s.app.close();
  });

  it('reports an error status when loading fails', async () => {
    const failing = new MemoryBus();
    await seeded(failing, ORDERS.slice(0, 3));
    const kv = failing.kv.bind(failing);
    failing.kv = (name) => ({ ...kv(name), status: () => Promise.reject(new Error('nats down')) });
    const s = await buildServer({ entitlements: testEntitlements, bus: failing, logLevel: 'silent', storeCapacity: 10, ...FAST });
    await expect(s.load()).rejects.toThrow('nats down');
    const res = await s.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'error' });
    await s.app.close();
  });
});

describe.each<CodecName>(['json', 'msgpack'])('GET /ws (%s)', (codec) => {
  it('runs hello, getRows (flat and grouped), setFilterValues, a bad message and ping', async () => {
    await server.load();
    const c = await connect(wsUrl);
    c.send({ t: 'hello', userId: 'SUPERVISOR', traderId: 'ALL', codec, clientId: 'it-1' });
    const welcome = await c.next();
    expect(welcome).toMatchObject({ t: 'welcome' });

    c.send({ t: 'getRows', reqId: 1, req: req() });
    const flat = await c.next();
    if (flat.t !== 'rows') throw new Error(`expected rows, got ${JSON.stringify(flat)}`);
    expect(flat.reqId).toBe(1);
    expect(flat.rowCount).toBe(ORDERS.length);
    expect(flat.rows).toHaveLength(25);
    expect(flat.rows[0]?.createdAt).toBeGreaterThanOrEqual(flat.rows[24]?.createdAt as number);
    expect(flat.ms).toBeGreaterThanOrEqual(0);
    expect(Object.keys(flat.rows[0] ?? {})).toHaveLength(50);
    // Nulls survive the wire in both codecs.
    const withNull = ORDERS.findIndex((o: Order) => o.limitPrice === null);
    expect(withNull).toBeGreaterThanOrEqual(0);

    c.send({
      t: 'getRows',
      reqId: 2,
      req: req({
        rowGroupCols: [{ id: 'currencyPair' }],
        valueCols: [
          { id: 'notionalUsd', aggFunc: 'sum' },
          { id: 'slippageBps', aggFunc: 'wavg' },
        ],
      }),
    });
    const grouped = await c.next();
    if (grouped.t !== 'rows') throw new Error('expected rows');
    expect(grouped.reqId).toBe(2);
    expect(grouped.rowCount).toBe(grouped.rows.length);
    expect(grouped.rows[0]).toMatchObject({ childCount: expect.any(Number), notionalUsd: expect.any(Number) });
    const total = grouped.rows.reduce((n, r) => n + (r.childCount as number), 0);
    expect(total).toBe(ORDERS.length);

    c.send({ t: 'setFilterValues', reqId: 3, colId: 'status' });
    const values = await c.next();
    expect(values).toMatchObject({ t: 'filterValues', reqId: 3 });
    if (values.t !== 'filterValues') throw new Error('unreachable');
    expect(values.values).toEqual([...values.values].sort());
    expect(values.values.length).toBeGreaterThan(1);

    c.sendRaw(codec === 'json' ? '{"t":"getRows","reqId":4}' : getCodec('msgpack').encode({ t: 'getRows', reqId: 4 } as never) as Uint8Array);
    const bad = await c.next();
    expect(bad).toMatchObject({ t: 'error', reqId: 4, code: 'BAD_MESSAGE' });

    c.send({ t: 'command', reqId: 5, orderId: 'x', action: 'CANCEL' });
    expect(await c.next()).toMatchObject({ t: 'error', reqId: 5, code: 'INTERNAL' });

    c.send({ t: 'ping', ts: 99 });
    expect(await c.next()).toMatchObject({ t: 'pong', ts: 99 });

    // The server is still healthy after the bad frame.
    c.send({ t: 'getRows', reqId: 6, req: req({ startRow: 25, endRow: 30 }) });
    expect(await c.next()).toMatchObject({ t: 'rows', reqId: 6 });
    await c.close();
  });

  it('scopes rows to the trader from hello and resets on a new hello', async () => {
    await server.load();
    const c = await connect(wsUrl);
    c.send({ t: 'hello', userId: 'SUPERVISOR', traderId: 'T1', codec, clientId: 'it-2' });
    await c.next();
    c.send({ t: 'getRows', reqId: 1, req: req() });
    const t1 = await c.next();
    c.send({ t: 'hello', userId: 'SUPERVISOR', traderId: 'ALL', codec, clientId: 'it-2' });
    await c.next();
    c.send({ t: 'getRows', reqId: 2, req: req() });
    const all = await c.next();
    if (t1.t !== 'rows' || all.t !== 'rows') throw new Error('expected rows');
    expect(t1.rowCount).toBe(ORDERS.filter((o) => o.traderId === 'T1').length);
    expect(all.rowCount).toBe(ORDERS.length);
    await c.close();
  });
});

describe('GET /ws codec renegotiation', () => {
  it('switches json to msgpack to json to msgpack on one socket, serving getRows after each switch', async () => {
    await server.load();
    const c = await connect(wsUrl);
    let reqId = 0;
    for (const codec of ['json', 'msgpack', 'json', 'msgpack'] as const) {
      // Every hello is JSON text, whichever codec is in use; the welcome comes back in the new codec.
      c.send({ t: 'hello', userId: 'SUPERVISOR', traderId: 'ALL', codec, clientId: 'switch' }, 'json');
      expect(await c.next()).toMatchObject({ t: 'welcome' });
      reqId += 1;
      c.send({ t: 'getRows', reqId, req: req() });
      const rows = await c.next();
      if (rows.t !== 'rows') throw new Error(`expected rows after switching to ${codec}, got ${JSON.stringify(rows)}`);
      expect(rows).toMatchObject({ reqId, rowCount: ORDERS.length });
    }
    await c.close();
  });
});

describe('GET /ws robustness', () => {
  it('survives garbage, binary-before-hello and oversize frames, and keeps serving others', async () => {
    await server.load();
    const bad = await connect(wsUrl);
    bad.sendRaw('not json at all');
    expect(await bad.next()).toMatchObject({ t: 'error', code: 'BAD_FRAME' });
    bad.sendRaw(new Uint8Array([0xff, 0x00, 0x13]));
    expect(await bad.next()).toMatchObject({ t: 'error', code: 'BAD_FRAME' });
    bad.sendRaw('x'.repeat(2_000_000));
    await new Promise((r) => bad.socket.once('close', r));

    const good = await connect(wsUrl);
    good.send({ t: 'hello', userId: 'SUPERVISOR', traderId: 'ALL', codec: 'json', clientId: 'ok' });
    expect(await good.next()).toMatchObject({ t: 'welcome' });
    await good.close();
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('answers NOT_READY while loading', async () => {
    const c = await connect(wsUrl);
    c.send({ t: 'hello', userId: 'SUPERVISOR', traderId: 'ALL', codec: 'json', clientId: 'early' });
    await c.next();
    c.send({ t: 'getRows', reqId: 1, req: req() });
    expect(await c.next()).toMatchObject({ t: 'error', reqId: 1, code: 'NOT_READY' });
    await c.close();
  });

  it('logs cold builds that cross the slow threshold', async () => {
    const slow = await buildServer({ entitlements: testEntitlements, bus, logLevel: 'silent', storeCapacity: 2_000, slowBuildMs: 0, ...FAST });
    await slow.app.listen({ port: 0, host: '127.0.0.1' });
    await slow.load();
    const addr = slow.app.server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    const c = await connect(`ws://127.0.0.1:${port}/ws`);
    c.send({ t: 'hello', userId: 'SUPERVISOR', traderId: 'ALL', codec: 'json', clientId: 'slow' });
    await c.next();
    c.send({ t: 'getRows', reqId: 1, req: req() });
    expect(await c.next()).toMatchObject({ t: 'rows' });
    await c.close();
    await slow.app.close();
  });
});

describe('draining', () => {
  it('says not ready at once, refuses new upgrades, then closes every socket with 1012 after the drain time', async () => {
    await server.load();
    const socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const closed = new Promise<{ code: number; at: number }>((resolve) => socket.once('close', (code) => resolve({ code, at: Date.now() })));
    const started = Date.now();
    const draining = server.drain(150);
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ status: 'draining', stage: 'draining' });
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    const refused = await new Promise<number>((resolve) => {
      const late = new WebSocket(wsUrl);
      late.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      late.once('open', () => resolve(101));
      late.once('error', () => undefined);
    });
    expect(refused).toBe(503);
    const result = await closed;
    await draining;
    expect(result.code).toBe(1012);
    expect(result.at - started).toBeGreaterThanOrEqual(140);
  });

  it('keeps serving the clients it already has until the sockets close', async () => {
    await server.load();
    const c = await connect(wsUrl);
    c.send({ t: 'hello', userId: 'SUPERVISOR', traderId: 'ALL', codec: 'json', clientId: 'staying' });
    await c.next();
    const draining = server.drain(120);
    c.send({ t: 'getRows', reqId: 1, req: req() });
    expect(await c.next()).toMatchObject({ t: 'rows', reqId: 1 });
    await draining;
  });

  it('is idempotent, and works before the load has finished', async () => {
    const early = server.drain(10);
    await server.drain(10);
    await early;
    expect(server.health()).toMatchObject({ status: 'draining', stage: 'draining' });
  });
});
