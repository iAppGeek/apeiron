import { jsonCodec, msgpackCodec, type ClientMsg, type ServerMsg, type SsrmRequest } from '@apeiron/logos';
import { describe, expect, it, vi } from 'vitest';
import { QueryEngine } from './query/engine.js';
import { ClientSession, type SessionDeps } from './session.js';
import { makeStore } from './testing/orders.js';
import type { Connection, Frame } from './transport.js';

const store = makeStore([
  { traderId: 'T1', venue: 'EBS', orderQty: 1, createdAt: 1 },
  { traderId: 'T2', venue: 'LMAX', orderQty: 2, createdAt: 2 },
  { traderId: 'T1', venue: 'LMAX', orderQty: 3, createdAt: 3 },
]);
const engine = new QueryEngine(store, { maxViews: 4, maxBytes: 1 << 20, maxBlockRows: 1_000 });

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

type Harness = { session: ClientSession; sent: Frame[]; connection: Connection; deps: SessionDeps };

function harness(overrides: Partial<SessionDeps> = {}): Harness {
  const sent: Frame[] = [];
  const connection: Connection = {
    send: vi.fn((f: Frame) => {
      sent.push(f);
    }),
    close: vi.fn(),
    bufferedAmount: 0,
  };
  const deps: SessionDeps = {
    engine: () => engine,
    log: { warn: vi.fn(), error: vi.fn() },
    now: () => 1234,
    ...overrides,
  };
  return { session: new ClientSession(connection, deps), sent, connection, deps };
}

const json = (m: ClientMsg): string => JSON.stringify(m);
const hello = (traderId = 'ALL', codec: 'json' | 'msgpack' = 'json'): ClientMsg => ({
  t: 'hello',
  traderId,
  codec,
  clientId: 'c1',
});
const decodeJson = (f: Frame): ServerMsg => jsonCodec.decode(f) as ServerMsg;
const decodePack = (f: Frame): ServerMsg => msgpackCodec.decode(f) as ServerMsg;

describe('ClientSession handshake', () => {
  it('replies to hello with welcome (traders, columnsVersion) as JSON text', () => {
    const h = harness();
    h.session.handleFrame(json(hello()));
    expect(typeof h.sent[0]).toBe('string');
    const msg = decodeJson(h.sent[0] as Frame);
    expect(msg).toMatchObject({ t: 'welcome', serverTime: 1234 });
    if (msg.t !== 'welcome') throw new Error('unreachable');
    expect(msg.traders.map((t) => t.traderId)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5']);
    expect(msg.columnsVersion).toMatch(/^[0-9a-f]{8}$/);
    expect(msg.preset).toBeNull();
    expect(h.session.trader).toBe('ALL');
    expect(h.session.id).toBe('c1');
  });

  it('requires the first frame to be JSON text', () => {
    const h = harness();
    h.session.handleFrame(new Uint8Array([1, 2, 3]));
    expect(decodeJson(h.sent[0] as Frame)).toMatchObject({ t: 'error', code: 'BAD_FRAME' });
    h.session.handleFrame('{not json');
    expect(decodeJson(h.sent[1] as Frame)).toMatchObject({ t: 'error', code: 'BAD_FRAME' });
  });

  it('rejects requests before hello and keeps the request id', () => {
    const h = harness();
    h.session.handleFrame(json({ t: 'getRows', reqId: 5, req: req() }));
    h.session.handleFrame(json({ t: 'setFilterValues', reqId: 6, colId: 'venue' }));
    expect(decodeJson(h.sent[0] as Frame)).toEqual({
      t: 'error',
      reqId: 5,
      code: 'HELLO_REQUIRED',
      message: 'Send hello first',
    });
    expect(decodeJson(h.sent[1] as Frame)).toMatchObject({ reqId: 6, code: 'HELLO_REQUIRED' });
  });

  it('rejects an unknown trader and stays un-negotiated', () => {
    const h = harness();
    h.session.handleFrame(json(hello('T99')));
    expect(decodeJson(h.sent[0] as Frame)).toMatchObject({ t: 'error', code: 'UNKNOWN_TRADER' });
    h.session.handleFrame(json({ t: 'getRows', reqId: 1, req: req() }));
    expect(decodeJson(h.sent[1] as Frame)).toMatchObject({ code: 'HELLO_REQUIRED' });
  });

  it('answers ping before and after hello', () => {
    const h = harness();
    h.session.handleFrame(json({ t: 'ping', ts: 77 }));
    expect(decodeJson(h.sent[0] as Frame)).toEqual({ t: 'pong', ts: 77, serverTs: 1234 });
    h.session.handleFrame(json(hello()));
    h.session.handleFrame(json({ t: 'ping', ts: 78 }));
    expect(decodeJson(h.sent[2] as Frame)).toEqual({ t: 'pong', ts: 78, serverTs: 1234 });
  });
});

describe('ClientSession requests', () => {
  function ready(trader = 'ALL', codec: 'json' | 'msgpack' = 'json', overrides: Partial<SessionDeps> = {}): Harness {
    const h = harness(overrides);
    h.session.handleFrame(json(hello(trader, codec)));
    h.sent.length = 0;
    return h;
  }

  it('serves getRows with rows, rowCount and server time', () => {
    const h = ready();
    h.session.handleFrame(json({ t: 'getRows', reqId: 3, req: req() }));
    const msg = decodeJson(h.sent[0] as Frame);
    expect(msg).toMatchObject({ t: 'rows', reqId: 3, rowCount: 3 });
    if (msg.t !== 'rows') throw new Error('unreachable');
    expect(msg.ms).toBeGreaterThanOrEqual(0);
    expect(msg.rows.map((r) => r.createdAt)).toEqual([3, 2, 1]);
  });

  it('applies the hello trader scope', () => {
    const h = ready('T1');
    h.session.handleFrame(json({ t: 'getRows', reqId: 1, req: req() }));
    expect(decodeJson(h.sent[0] as Frame)).toMatchObject({ rowCount: 2 });
  });

  it('a new hello resets the trader scope', () => {
    const h = ready('T1');
    h.session.handleFrame(json(hello('T2')));
    h.session.handleFrame(json({ t: 'getRows', reqId: 1, req: req() }));
    expect(decodeJson(h.sent[1] as Frame)).toMatchObject({ t: 'rows', rowCount: 1 });
    expect(h.session.trader).toBe('T2');
  });

  it('can switch codec with a later hello', () => {
    const h = ready('ALL', 'json');
    h.session.handleFrame(json(hello('ALL', 'msgpack')));
    expect(h.sent[0]).toBeInstanceOf(Uint8Array);
    expect(h.session.codecName).toBe('msgpack');
  });

  it('speaks msgpack in binary frames after a msgpack hello', () => {
    const h = ready('ALL', 'msgpack');
    expect(h.session.codecName).toBe('msgpack');
    h.session.handleFrame(msgpackCodec.encode({ t: 'getRows', reqId: 9, req: req() }) as Uint8Array);
    expect(h.sent[0]).toBeInstanceOf(Uint8Array);
    expect(decodePack(h.sent[0] as Frame)).toMatchObject({ t: 'rows', reqId: 9, rowCount: 3 });
    h.session.handleFrame(msgpackCodec.encode({ t: 'ping', ts: 4 }) as Uint8Array);
    expect(decodePack(h.sent[1] as Frame)).toMatchObject({ t: 'pong', ts: 4 });
  });

  it('decodes frames by type, so a JSON text frame works in msgpack mode and gets a msgpack reply', () => {
    const h = ready('ALL', 'msgpack');
    h.session.handleFrame('{"t":"ping","ts":1}');
    expect(decodePack(h.sent[0] as Frame)).toEqual({ t: 'pong', ts: 1, serverTs: 1234 });
  });

  it('decodes a binary frame in json mode as msgpack and replies in JSON text', () => {
    const h = ready('ALL', 'json');
    h.session.handleFrame(msgpackCodec.encode({ t: 'ping', ts: 2 }) as Uint8Array);
    expect(decodeJson(h.sent[0] as Frame)).toEqual({ t: 'pong', ts: 2, serverTs: 1234 });
  });

  it('rejects garbage in either frame type without crashing', () => {
    const h = ready('ALL', 'msgpack');
    h.session.handleFrame('{not json');
    h.session.handleFrame(new Uint8Array([0xc1]));
    expect(decodePack(h.sent[0] as Frame)).toMatchObject({ t: 'error', code: 'BAD_FRAME', message: expect.stringContaining('json') });
    expect(decodePack(h.sent[1] as Frame)).toMatchObject({ t: 'error', code: 'BAD_FRAME', message: expect.stringContaining('msgpack') });
  });

  it('switches json to msgpack to json to msgpack with JSON text hellos, serving getRows after each', () => {
    const h = harness();
    const rowsOk = (decode: (f: Frame) => ServerMsg, encode: (m: ClientMsg) => Frame, id: number): void => {
      h.sent.length = 0;
      h.session.handleFrame(encode({ t: 'getRows', reqId: id, req: req() }));
      expect(decode(h.sent[0] as Frame)).toMatchObject({ t: 'rows', reqId: id, rowCount: 3 });
    };
    const asJson = (m: ClientMsg): Frame => json(m);
    const asPack = (m: ClientMsg): Frame => msgpackCodec.encode(m) as Uint8Array;
    h.session.handleFrame(json(hello('ALL', 'json')));
    rowsOk(decodeJson, asJson, 1);
    h.sent.length = 0;
    h.session.handleFrame(json(hello('ALL', 'msgpack')));
    expect(h.sent[0]).toBeInstanceOf(Uint8Array);
    expect(decodePack(h.sent[0] as Frame)).toMatchObject({ t: 'welcome' });
    rowsOk(decodePack, asPack, 2);
    h.sent.length = 0;
    h.session.handleFrame(json(hello('ALL', 'json')));
    expect(typeof h.sent[0]).toBe('string');
    expect(decodeJson(h.sent[0] as Frame)).toMatchObject({ t: 'welcome' });
    expect(h.session.codecName).toBe('json');
    rowsOk(decodeJson, asJson, 3);
    h.sent.length = 0;
    h.session.handleFrame(json(hello('ALL', 'msgpack')));
    expect(h.session.codecName).toBe('msgpack');
    rowsOk(decodePack, asPack, 4);
  });

  it('serves setFilterValues', () => {
    const h = ready('T1');
    h.session.handleFrame(json({ t: 'setFilterValues', reqId: 4, colId: 'venue' }));
    expect(decodeJson(h.sent[0] as Frame)).toEqual({ t: 'filterValues', reqId: 4, values: ['EBS', 'LMAX'] });
    h.session.handleFrame(json({ t: 'setFilterValues', reqId: 5, colId: 'orderId' }));
    expect(decodeJson(h.sent[1] as Frame)).toMatchObject({ t: 'error', reqId: 5, code: 'UNSUPPORTED_COLUMN' });
  });

  it('maps engine validation errors to error frames with the request id', () => {
    const h = ready();
    h.session.handleFrame(json({ t: 'getRows', reqId: 8, req: req({ pivotMode: true }) }));
    expect(decodeJson(h.sent[0] as Frame)).toMatchObject({ t: 'error', reqId: 8, code: 'UNSUPPORTED_PIVOT' });
    h.session.handleFrame(json({ t: 'getRows', reqId: 9, req: req({ valueCols: [{ id: 'orderQty', aggFunc: 'min' }] }) }));
    expect(decodeJson(h.sent[1] as Frame)).toMatchObject({ reqId: 9, code: 'UNSUPPORTED_AGG' });
    h.session.handleFrame(json({ t: 'getRows', reqId: 10, req: req({ filterModel: { orderQty: { filterType: 'x' } } }) }));
    expect(decodeJson(h.sent[2] as Frame)).toMatchObject({ reqId: 10, code: 'UNSUPPORTED_FILTER' });
  });

  it('answers command and control with NOT_IMPLEMENTED', () => {
    const h = ready();
    h.session.handleFrame(json({ t: 'command', reqId: 11, orderId: 'x', action: 'CANCEL' }));
    h.session.handleFrame(json({ t: 'control', reqId: 12, preset: 'stress' }));
    expect(decodeJson(h.sent[0] as Frame)).toMatchObject({ reqId: 11, code: 'NOT_IMPLEMENTED' });
    expect(decodeJson(h.sent[1] as Frame)).toMatchObject({ reqId: 12, code: 'NOT_IMPLEMENTED' });
  });

  it('rejects malformed messages with BAD_MESSAGE, keeping a usable request id', () => {
    const h = ready();
    h.session.handleFrame(JSON.stringify({ t: 'getRows', reqId: 21, req: { startRow: -1 } }));
    expect(decodeJson(h.sent[0] as Frame)).toMatchObject({ t: 'error', reqId: 21, code: 'BAD_MESSAGE' });
    h.session.handleFrame(JSON.stringify({ t: 'nope' }));
    expect(decodeJson(h.sent[1] as Frame)).toMatchObject({ t: 'error', code: 'BAD_MESSAGE' });
    expect(decodeJson(h.sent[1] as Frame)).not.toHaveProperty('reqId');
    h.session.handleFrame('42');
    expect(decodeJson(h.sent[2] as Frame)).toMatchObject({ code: 'BAD_MESSAGE' });
    h.session.handleFrame('null');
    expect(decodeJson(h.sent[3] as Frame)).toMatchObject({ code: 'BAD_MESSAGE' });
  });

  it('says NOT_READY while the store is loading', () => {
    const h = ready('ALL', 'json', { engine: () => null });
    h.session.handleFrame(json({ t: 'getRows', reqId: 1, req: req() }));
    h.session.handleFrame(json({ t: 'setFilterValues', reqId: 2, colId: 'venue' }));
    expect(decodeJson(h.sent[0] as Frame)).toMatchObject({ reqId: 1, code: 'NOT_READY' });
    expect(decodeJson(h.sent[1] as Frame)).toMatchObject({ reqId: 2, code: 'NOT_READY' });
  });

  it('turns an unexpected exception into INTERNAL instead of throwing', () => {
    const broken = { getRows: vi.fn(() => { throw new Error('kaboom'); }) } as unknown as QueryEngine;
    const h = ready('ALL', 'json', { engine: () => broken });
    expect(() => h.session.handleFrame(json({ t: 'getRows', reqId: 1, req: req() }))).not.toThrow();
    expect(decodeJson(h.sent[0] as Frame)).toMatchObject({ t: 'error', code: 'INTERNAL' });
    expect(h.deps.log.error).toHaveBeenCalled();
  });

  it('survives a failing send', () => {
    const h = ready();
    vi.mocked(h.connection.send).mockImplementation(() => {
      throw new Error('socket gone');
    });
    expect(() => h.session.handleFrame(json({ t: 'ping', ts: 1 }))).not.toThrow();
    expect(h.deps.log.warn).toHaveBeenCalled();
  });

  it('ignores frames after the connection closed', () => {
    const h = ready();
    h.session.handlers().onClose();
    h.session.handlers().onFrame(json({ t: 'ping', ts: 1 }));
    expect(h.sent).toHaveLength(0);
  });

  it('reports every getRows to onRows', () => {
    const onRows = vi.fn();
    const h = ready('ALL', 'json', { onRows });
    h.session.handleFrame(json({ t: 'getRows', reqId: 1, req: req() }));
    expect(onRows).toHaveBeenCalledWith(expect.objectContaining({ built: expect.any(Boolean), rowCount: 3 }));
  });
});
