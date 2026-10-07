import { jsonCodec, msgpackCodec, type ClientMsg, type ServerMsg } from '@apeiron/logos';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createConnectionCore,
  type Clock,
  type ConnectionCore,
  type CoreOptions,
  type SocketLike,
} from './connection-core';
import type { WorkerToMain } from './messages';

class FakeSocket implements SocketLike {
  readyState = 0;
  binaryType = 'blob';
  sent: (string | Uint8Array)[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  drop(code?: number): void {
    this.readyState = 3;
    this.onclose?.(code === undefined ? undefined : { code });
  }
  receive(msg: ServerMsg, codec: 'json' | 'msgpack' = 'json'): void {
    if (codec === 'json') this.onmessage?.({ data: jsonCodec.encode(msg) });
    else {
      const bytes = msgpackCodec.encode(msg) as Uint8Array;
      this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    }
  }
  /** Decodes what the client sent: text frames as JSON, binary frames as msgpack. */
  sentMsgs(): ClientMsg[] {
    return this.sent.map((f) => (typeof f === 'string' ? jsonCodec.decode(f) : msgpackCodec.decode(f)) as ClientMsg);
  }
}

type Timer = { id: number; at: number; every: number | null; fn: () => void };
class FakeClock implements Clock {
  time = 1000;
  private seq = 1;
  timers = new Map<number, Timer>();
  now(): number {
    return this.time;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.seq++;
    this.timers.set(id, { id, at: this.time + ms, every: null, fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  setInterval(fn: () => void, ms: number): unknown {
    const id = this.seq++;
    this.timers.set(id, { id, at: this.time + ms, every: ms, fn });
    return id;
  }
  clearInterval(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  random(): number {
    return 0.5;
  }
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.timers.values()].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (next === undefined) break;
      this.time = next.at;
      if (next.every === null) this.timers.delete(next.id);
      else next.at += next.every;
      next.fn();
    }
    this.time = end;
  }
}

const welcome: ServerMsg = {
  t: 'welcome',
  serverTime: 1,
  traders: [{ traderId: 'T1', traderName: 'Alice' }],
  columnsVersion: 'abc',
};

type Rig = {
  core: ConnectionCore;
  clock: FakeClock;
  sockets: FakeSocket[];
  events: WorkerToMain[];
  last: () => FakeSocket;
  ofKind: <K extends WorkerToMain['kind']>(kind: K) => Extract<WorkerToMain, { kind: K }>[];
};

const makeRig = (options: Partial<CoreOptions> = {}): Rig => {
  const clock = new FakeClock();
  const sockets: FakeSocket[] = [];
  const events: WorkerToMain[] = [];
  const core = createConnectionCore({
    clock,
    clientId: 'client-1',
    options: { backoffJitter: 0, ...options },
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    emit: (e) => events.push(e),
  });
  return {
    core,
    clock,
    sockets,
    events,
    last: () => sockets[sockets.length - 1] as FakeSocket,
    ofKind: <K extends WorkerToMain['kind']>(kind: K) =>
      events.filter((e): e is Extract<WorkerToMain, { kind: K }> => e.kind === kind),
  };
};

describe('handshake', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
  });

  it('sends a JSON hello as the very first frame', () => {
    rig.core.connect('ws://x/ws');
    rig.last().open();
    expect(rig.last().url).toBe('ws://x/ws');
    expect(rig.last().binaryType).toBe('arraybuffer');
    expect(typeof rig.last().sent[0]).toBe('string');
    expect(rig.last().sentMsgs()[0]).toEqual({ t: 'hello', traderId: 'ALL', codec: 'json', clientId: 'client-1' });
  });

  it('reports connecting, then connected on welcome, and resolves queued hellos', () => {
    rig.core.connect('ws://x/ws');
    rig.core.hello(7, 'T1', 'json');
    rig.last().open();
    expect(rig.last().sentMsgs()).toHaveLength(1);
    expect(rig.last().sentMsgs()[0]).toMatchObject({ t: 'hello', traderId: 'T1' });
    rig.last().receive(welcome);
    expect(rig.ofKind('status').map((s) => s.status)).toEqual(['connecting', 'connected']);
    expect(rig.ofKind('hello-result')).toEqual([{ kind: 'hello-result', id: 7, ok: true, welcome }]);
    expect(rig.ofKind('message')).toEqual([{ kind: 'message', msg: welcome }]);
  });

  it('does not send requests before the socket is open', () => {
    rig.core.connect('ws://x/ws');
    rig.core.request({ t: 'getRows', reqId: 1, req: { startRow: 0, endRow: 1, rowGroupCols: [], valueCols: [], groupKeys: [], sortModel: [] } });
    expect(rig.ofKind('response')).toEqual([
      { kind: 'response', reqId: 1, ok: false, code: 'DISCONNECTED', message: 'Not connected' },
    ]);
  });
});

describe('codec switching', () => {
  it('sends hello as JSON text even when switching to msgpack, then speaks msgpack', () => {
    const rig = makeRig();
    rig.core.connect('ws://x/ws');
    rig.last().open();
    rig.last().receive(welcome);
    rig.core.hello(1, 'ALL', 'msgpack');
    const sock = rig.last();
    // sent[1] is the immediate ping after welcome
    expect(typeof sock.sent[2]).toBe('string');
    expect(jsonCodec.decode(sock.sent[2] as string)).toMatchObject({ t: 'hello', codec: 'msgpack' });
    rig.core.request({ t: 'setFilterValues', reqId: 5, colId: 'venue' });
    expect(sock.sent[3]).toBeInstanceOf(Uint8Array);
    expect(msgpackCodec.decode(sock.sent[3] as Uint8Array)).toEqual({ t: 'setFilterValues', reqId: 5, colId: 'venue' });
  });

  it('decodes each frame by its own type, so frames in flight during a switch still decode', () => {
    const rig = makeRig();
    rig.core.connect('ws://x/ws');
    rig.last().open();
    rig.last().receive(welcome);
    rig.core.request({ t: 'setFilterValues', reqId: 1, colId: 'venue' });
    rig.core.hello(2, 'ALL', 'msgpack');
    rig.last().receive({ t: 'filterValues', reqId: 1, values: ['A'] }, 'json');
    rig.last().receive(welcome, 'msgpack');
    expect(rig.ofKind('response')).toEqual([
      { kind: 'response', reqId: 1, ok: true, msg: { t: 'filterValues', reqId: 1, values: ['A'] } },
    ]);
    expect(rig.ofKind('hello-result').filter((r) => r.id === 2)).toHaveLength(1);
  });

  it('switches back to JSON', () => {
    const rig = makeRig();
    rig.core.connect('ws://x/ws');
    rig.core.hello(1, 'ALL', 'msgpack');
    rig.last().open();
    rig.last().receive(welcome, 'msgpack');
    rig.core.hello(2, 'ALL', 'json');
    rig.core.request({ t: 'setFilterValues', reqId: 5, colId: 'venue' });
    expect(typeof rig.last().sent[3]).toBe('string');
  });

  it('falls back to the confirmed settings when the server rejects a hello', () => {
    const rig = makeRig();
    rig.core.connect('ws://x/ws');
    rig.last().open();
    rig.last().receive(welcome);
    rig.core.hello(3, 'NOBODY', 'msgpack');
    rig.last().receive({ t: 'error', code: 'UNKNOWN_TRADER', message: 'Unknown trader: NOBODY' });
    expect(rig.ofKind('hello-result').find((r) => r.id === 3)).toMatchObject({ ok: false, code: 'UNKNOWN_TRADER' });
    rig.core.request({ t: 'setFilterValues', reqId: 9, colId: 'venue' });
    expect(typeof rig.last().sent.at(-1)).toBe('string');
    rig.last().drop();
    rig.clock.advance(500);
    rig.last().open();
    expect(rig.last().sentMsgs()[0]).toMatchObject({ traderId: 'ALL', codec: 'json' });
  });
});

describe('request matching', () => {
  const req = { startRow: 0, endRow: 100, rowGroupCols: [], valueCols: [], groupKeys: [], sortModel: [] };

  it('matches rows, filterValues and errors to their reqId, out of order', () => {
    const rig = makeRig();
    rig.core.connect('ws://x/ws');
    rig.last().open();
    rig.last().receive(welcome);
    rig.core.request({ t: 'getRows', reqId: 1, req });
    rig.core.request({ t: 'getRows', reqId: 2, req });
    rig.core.request({ t: 'setFilterValues', reqId: 3, colId: 'venue' });
    rig.last().receive({ t: 'filterValues', reqId: 3, values: ['EBS'] });
    rig.last().receive({ t: 'error', reqId: 1, code: 'UNSUPPORTED_AGG', message: 'no' });
    rig.last().receive({ t: 'rows', reqId: 2, rows: [], rowCount: 5, ms: 1 });
    const responses = rig.ofKind('response');
    expect(responses.map((r) => r.reqId)).toEqual([3, 1, 2]);
    expect(responses[1]).toMatchObject({ ok: false, code: 'UNSUPPORTED_AGG', message: 'no' });
    expect(responses[2]).toMatchObject({ ok: true, msg: { t: 'rows', rowCount: 5 } });
  });

  it('forwards responses with an unknown reqId, and unsolicited messages, as messages', () => {
    const rig = makeRig();
    rig.core.connect('ws://x/ws');
    rig.last().open();
    rig.last().receive(welcome);
    rig.last().receive({ t: 'rows', reqId: 99, rows: [], rowCount: 0, ms: 1 });
    rig.last().receive({ t: 'error', code: 'INTERNAL', message: 'oops' });
    rig.last().receive({
      t: 'summary',
      byStatus: { PENDING_START: 0, LIVE: 0, PAUSED: 0, FILLED: 0, CANCELLED: 0 },
      liveNotionalUsd: 0,
      totalRows: 0,
      server: { cpu: 1, rssMb: 2, elLagMs: 3 },
    });
    expect(rig.ofKind('message').map((m) => m.msg.t)).toEqual(['welcome', 'rows', 'error', 'summary']);
    expect(rig.ofKind('response')).toHaveLength(0);
  });

  it('times out a request that never gets an answer', () => {
    const rig = makeRig({ requestTimeoutMs: 5000 });
    rig.core.connect('ws://x/ws');
    rig.last().open();
    rig.core.request({ t: 'getRows', reqId: 1, req });
    rig.clock.advance(4999);
    expect(rig.ofKind('response')).toHaveLength(0);
    rig.clock.advance(16);
    expect(rig.ofKind('response')[0]).toMatchObject({ reqId: 1, ok: false, code: 'TIMEOUT' });
  });

  it('reports undecodable frames as BAD_FRAME messages', () => {
    const rig = makeRig();
    rig.core.connect('ws://x/ws');
    rig.last().open();
    rig.last().onmessage?.({ data: 'not json' });
    rig.last().onmessage?.({ data: 42 });
    const msgs = rig.ofKind('message').map((m) => m.msg);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ t: 'error', code: 'BAD_FRAME' });
  });

  it('ignores frames that are not server messages', () => {
    const rig = makeRig();
    rig.core.connect('ws://x/ws');
    rig.last().open();
    rig.last().onmessage?.({ data: JSON.stringify({ t: 'getRows' }) });
    expect(rig.ofKind('message')).toHaveLength(0);
  });
});

describe('reconnect', () => {
  it('fails pending requests, then reconnects with exponential backoff and re-sends hello', () => {
    const rig = makeRig({ backoffBaseMs: 500, backoffMaxMs: 2000 });
    rig.core.connect('ws://x/ws');
    rig.core.hello(1, 'T2', 'msgpack');
    rig.last().open();
    rig.last().receive(welcome);
    rig.core.request({ t: 'setFilterValues', reqId: 4, colId: 'venue' });
    rig.last().drop();
    expect(rig.ofKind('response')[0]).toMatchObject({ reqId: 4, ok: false, code: 'DISCONNECTED' });
    expect(rig.ofKind('status').at(-1)).toMatchObject({ status: 'reconnecting', attempt: 1 });

    rig.clock.advance(499);
    expect(rig.sockets).toHaveLength(1);
    rig.clock.advance(1);
    expect(rig.sockets).toHaveLength(2);
    rig.last().drop();
    rig.clock.advance(999);
    expect(rig.sockets).toHaveLength(2);
    rig.clock.advance(1);
    expect(rig.sockets).toHaveLength(3);
    rig.last().drop();
    rig.clock.advance(2000);
    expect(rig.sockets).toHaveLength(4);
    rig.last().drop();
    rig.clock.advance(1999);
    expect(rig.sockets).toHaveLength(4);
    rig.clock.advance(1);
    expect(rig.sockets).toHaveLength(5);

    rig.last().open();
    const hello = rig.last().sentMsgs()[0];
    expect(typeof rig.last().sent[0]).toBe('string');
    expect(hello).toEqual({ t: 'hello', traderId: 'T2', codec: 'msgpack', clientId: 'client-1' });
    rig.last().receive(welcome, 'msgpack');
    expect(rig.ofKind('status').at(-1)).toMatchObject({ status: 'connected', attempt: 0, codec: 'msgpack' });
  });

  it('resets the backoff after a successful welcome', () => {
    const rig = makeRig({ backoffBaseMs: 500 });
    rig.core.connect('ws://x/ws');
    rig.last().open();
    rig.last().receive(welcome);
    rig.last().drop();
    rig.clock.advance(500);
    rig.last().open();
    rig.last().receive(welcome);
    rig.last().drop();
    rig.clock.advance(499);
    expect(rig.sockets).toHaveLength(2);
    rig.clock.advance(1);
    expect(rig.sockets).toHaveLength(3);
  });

  it('applies jitter to the delay', () => {
    const rig = makeRig({ backoffBaseMs: 1000, backoffJitter: 0.2 });
    rig.core.connect('ws://x/ws');
    rig.last().open();
    rig.last().drop();
    // random() is 0.5, so the jitter factor is exactly 0
    rig.clock.advance(999);
    expect(rig.sockets).toHaveLength(1);
    rig.clock.advance(1);
    expect(rig.sockets).toHaveLength(2);
  });

  it('does not reconnect after close()', () => {
    const rig = makeRig();
    rig.core.connect('ws://x/ws');
    rig.last().open();
    rig.core.close();
    expect(rig.last().closed).toBe(true);
    rig.clock.advance(60_000);
    expect(rig.sockets).toHaveLength(1);
    expect(rig.ofKind('status').at(-1)?.status).toBe('closed');
  });

  it('rejects hellos that were in flight when the link dropped', () => {
    const rig = makeRig();
    rig.core.connect('ws://x/ws');
    rig.core.hello(1, 'ALL', 'json');
    rig.last().open();
    rig.last().drop();
    expect(rig.ofKind('hello-result')[0]).toMatchObject({ id: 1, ok: false, code: 'DISCONNECTED' });
  });
});

describe('ping and stats', () => {
  it('pings right after welcome, then every 2s, and reports the round trip from the pong', () => {
    const rig = makeRig();
    rig.core.connect('ws://x/ws');
    rig.last().open();
    rig.last().receive(welcome);
    const pings = (): ClientMsg[] => rig.last().sentMsgs().filter((m) => m.t === 'ping');
    expect(pings()).toEqual([{ t: 'ping', ts: 1000 }]);
    rig.clock.advance(2000);
    expect(pings()).toEqual([
      { t: 'ping', ts: 1000 },
      { t: 'ping', ts: 3000 },
    ]);
    rig.clock.advance(7);
    rig.last().receive({ t: 'pong', ts: 3000, serverTs: 1 });
    rig.clock.advance(1000);
    expect(rig.ofKind('stats').at(-1)?.rttMs).toBe(7);
    rig.clock.advance(1000);
    expect(pings()).toHaveLength(3);
  });

  it('reports messages in and out per second, then resets the counters', () => {
    const rig = makeRig();
    rig.core.connect('ws://x/ws');
    rig.last().open();
    rig.last().receive(welcome);
    rig.last().receive({ t: 'pong', ts: 1000, serverTs: 1 });
    rig.clock.advance(1000);
    expect(rig.ofKind('stats')[0]).toMatchObject({ msgsIn: 2, msgsOut: 2, rttMs: 0 });
    rig.clock.advance(1000);
    expect(rig.ofKind('stats')[1]).toMatchObject({ msgsIn: 0, msgsOut: 1 });
  });

  it('stops pinging when the socket drops', () => {
    const rig = makeRig();
    rig.core.connect('ws://x/ws');
    rig.last().open();
    const first = rig.last();
    first.drop();
    const before = first.sent.length;
    rig.clock.advance(1500);
    expect(first.sent).toHaveLength(before);
  });
});

const delta = (seq: number, patch: Partial<Extract<ServerMsg, { t: 'delta' }>> = {}): ServerMsg => ({
  t: 'delta',
  seq,
  serverTs: 5000 + seq,
  updates: [],
  groupUpdates: [],
  adds: [],
  dirtyRoutes: [],
  rowCounts: [],
  newAbove: 0,
  ...patch,
});

const deltas = (rig: Rig): Extract<ServerMsg, { t: 'delta' }>[] =>
  rig
    .ofKind('message')
    .map((e) => e.msg)
    .filter((m): m is Extract<ServerMsg, { t: 'delta' }> => m.t === 'delta');

describe('clock offset', () => {
  it('estimates the server clock offset from the pong and reports it with the stats', () => {
    const rig = makeRig();
    rig.core.connect('ws://x/ws');
    rig.last().open();
    rig.last().receive(welcome);
    rig.clock.advance(10);
    // Sent at 1000, received at 1010: the server stamped 1005 + 250 on its own clock, so it is 250ms ahead.
    rig.last().receive({ t: 'pong', ts: 1000, serverTs: 1255 });
    rig.clock.advance(1000);
    expect(rig.ofKind('stats').at(-1)?.clockOffsetMs).toBe(250);
  });

  it('reports null until a pong has arrived', () => {
    const rig = makeRig();
    rig.core.connect('ws://x/ws');
    rig.last().open();
    rig.clock.advance(1000);
    expect(rig.ofKind('stats').at(-1)?.clockOffsetMs).toBeNull();
  });
});

describe('deltas', () => {
  const connected = (): Rig => {
    const rig = makeRig();
    rig.core.connect('ws://x/ws');
    rig.last().open();
    rig.last().receive(welcome);
    return rig;
  };

  it('passes deltas straight through at normal rates and counts them per second', () => {
    const rig = connected();
    for (let i = 1; i <= 5; i += 1) {
      rig.clock.advance(100);
      rig.last().receive(delta(i));
    }
    expect(deltas(rig).map((d) => d.seq)).toEqual([1, 2, 3, 4, 5]);
    rig.clock.advance(1000);
    expect(rig.ofKind('stats').find((s) => s.deltasIn > 0)?.deltasIn).toBeGreaterThan(0);
  });

  it('coalesces deltas arriving faster than 20 per second into one per frame, keeping the latest values', () => {
    const rig = connected();
    for (let i = 1; i <= 20; i += 1) {
      rig.clock.advance(10);
      rig.last().receive(delta(i, { updates: [{ route: [], rows: [{ orderId: 'A', marketMid: i }] }] }));
    }
    const direct = deltas(rig).length;
    expect(direct).toBe(20);
    // The 21st within a second starts coalescing: it and the next ones wait for the frame.
    for (let i = 21; i <= 23; i += 1) {
      rig.clock.advance(5);
      rig.last().receive(delta(i, { updates: [{ route: [], rows: [{ orderId: 'A', marketMid: i }] }], newAbove: 1 }));
    }
    expect(deltas(rig)).toHaveLength(direct);
    rig.clock.advance(16);
    const merged = deltas(rig).slice(direct);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ seq: 23, newAbove: 3 });
    expect(merged[0]?.updates).toEqual([{ route: [], rows: [{ orderId: 'A', marketMid: 23 }] }]);
  });

  it('hands over deltas held for a frame before reporting that the socket closed', () => {
    const rig = connected();
    for (let i = 1; i <= 22; i += 1) {
      rig.clock.advance(5);
      rig.last().receive(delta(i));
    }
    const before = deltas(rig).length;
    expect(before).toBeLessThan(22);
    rig.last().drop();
    expect(deltas(rig).length).toBeGreaterThan(before);
    const kinds = rig.events.map((e) => e.kind);
    expect(kinds.lastIndexOf('message')).toBeLessThan(kinds.indexOf('closed'));
  });
});

describe('close codes', () => {
  it('reports an unexpected close with its code, and reconnects', () => {
    const rig = makeRig();
    rig.core.connect('ws://x/ws');
    rig.last().open();
    rig.last().drop(1013);
    expect(rig.ofKind('closed')).toEqual([{ kind: 'closed', code: 1013 }]);
    rig.clock.advance(600);
    expect(rig.sockets).toHaveLength(2);
  });

  it('reports a missing code as null, and says nothing when the page closed the connection', () => {
    const rig = makeRig();
    rig.core.connect('ws://x/ws');
    rig.last().open();
    rig.last().drop();
    expect(rig.ofKind('closed')).toEqual([{ kind: 'closed', code: null }]);
    const quiet = makeRig();
    quiet.core.connect('ws://x/ws');
    quiet.last().open();
    quiet.core.close();
    expect(quiet.ofKind('closed')).toEqual([]);
  });
});
