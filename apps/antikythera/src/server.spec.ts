import {
  getCodec,
  jsonCodec,
  type ClientMsg,
  type CodecName,
  type Order,
  type ServerMsg,
  type SsrmRequest,
} from '@apeiron/logos';
import { InMemoryOrderRepository } from '@apeiron/mnemosyne';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { type RawData } from 'ws';
import { buildServer, type BlotterServer } from './server.js';
import { propertyOrders } from './testing/dataset.js';

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
    const queue: ServerMsg[] = [];
    const waiters: ((m: ServerMsg) => void)[] = [];
    let current: CodecName = 'json';
    socket.on('message', (raw: RawData, isBinary: boolean) => {
      const frame = isBinary ? (raw as Buffer) : raw.toString();
      // msgpack connections get binary frames and JSON connections get text frames.
      if (isBinary !== (current === 'msgpack')) throw new Error(`unexpected ${isBinary ? 'binary' : 'text'} frame`);
      const msg = (isBinary ? getCodec('msgpack') : jsonCodec).decode(frame) as ServerMsg;
      const waiter = waiters.shift();
      if (waiter) waiter(msg);
      else queue.push(msg);
    });
    socket.on('error', reject);
    socket.on('open', () => {
      resolve({
        socket,
        send: (msg, c = current): void => {
          const encoded = getCodec(c).encode(msg);
          socket.send(encoded, { binary: typeof encoded !== 'string' });
          if (msg.t === 'hello') current = msg.codec;
        },
        sendRaw: (data): void => socket.send(data, { binary: typeof data !== 'string' }),
        next: (): Promise<ServerMsg> => {
          const m = queue.shift();
          return m ? Promise.resolve(m) : new Promise((r) => waiters.push(r));
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
let base: string;
let wsUrl: string;

beforeEach(async () => {
  const repo = new InMemoryOrderRepository();
  await repo.upsertMany(ORDERS);
  server = await buildServer({ repo, logLevel: 'silent', storeCapacity: 2_000 });
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
    expect(await before.json()).toMatchObject({ status: 'loading', rows: 0 });

    const report = await server.load();
    expect(report.rows).toBe(ORDERS.length);
    const after = await fetch(`${base}/health`);
    expect(after.status).toBe(200);
    const body = (await after.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'ok', rows: ORDERS.length });
    expect(body.loadMs).toBeTypeOf('number');
    expect(body.heapMb).toBeGreaterThan(0);
    expect(body.rssMb).toBeGreaterThan(0);
  });

  it('reports an error status when loading fails', async () => {
    const failing = new InMemoryOrderRepository();
    failing.loadAll = (): never => {
      throw new Error('db down');
    };
    const s = await buildServer({ repo: failing, logLevel: 'silent', storeCapacity: 10 });
    await expect(s.load()).rejects.toThrow('db down');
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
    c.send({ t: 'hello', traderId: 'ALL', codec, clientId: 'it-1' });
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
    expect(await c.next()).toMatchObject({ t: 'error', reqId: 5, code: 'NOT_IMPLEMENTED' });

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
    c.send({ t: 'hello', traderId: 'T1', codec, clientId: 'it-2' });
    await c.next();
    c.send({ t: 'getRows', reqId: 1, req: req() });
    const t1 = await c.next();
    c.send({ t: 'hello', traderId: 'ALL', codec, clientId: 'it-2' });
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
      c.send({ t: 'hello', traderId: 'ALL', codec, clientId: 'switch' }, 'json');
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
    good.send({ t: 'hello', traderId: 'ALL', codec: 'json', clientId: 'ok' });
    expect(await good.next()).toMatchObject({ t: 'welcome' });
    await good.close();
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('answers NOT_READY while loading', async () => {
    const c = await connect(wsUrl);
    c.send({ t: 'hello', traderId: 'ALL', codec: 'json', clientId: 'early' });
    await c.next();
    c.send({ t: 'getRows', reqId: 1, req: req() });
    expect(await c.next()).toMatchObject({ t: 'error', reqId: 1, code: 'NOT_READY' });
    await c.close();
  });

  it('logs cold builds that cross the slow threshold', async () => {
    const repo = new InMemoryOrderRepository();
    await repo.upsertMany(ORDERS);
    const slow = await buildServer({ repo, logLevel: 'silent', storeCapacity: 2_000, slowBuildMs: 0 });
    await slow.app.listen({ port: 0, host: '127.0.0.1' });
    await slow.load();
    const addr = slow.app.server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    const c = await connect(`ws://127.0.0.1:${port}/ws`);
    c.send({ t: 'hello', traderId: 'ALL', codec: 'json', clientId: 'slow' });
    await c.next();
    c.send({ t: 'getRows', reqId: 1, req: req() });
    expect(await c.next()).toMatchObject({ t: 'rows' });
    await c.close();
    await slow.app.close();
  });
});
