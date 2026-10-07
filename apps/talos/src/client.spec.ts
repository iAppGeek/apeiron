import type { ServerMsg, SsrmRequest } from '@apeiron/logos';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TalosClient } from './client.js';
import { RunRecorder } from './recorder.js';
import { realClock } from './schedule.js';
import { FakeSocket, welcome } from './testing/fake-socket.js';

afterEach(() => vi.useRealTimers());

const REQ: SsrmRequest = { startRow: 0, endRow: 100, rowGroupCols: [], valueCols: [], groupKeys: [], sortModel: [], filterModel: null };

function setup(over: { excludeLatency?: boolean; onPreset?: (p: string | null) => void } = {}): { c: TalosClient; s: FakeSocket; r: RunRecorder } {
  vi.useFakeTimers({ now: 10_000 });
  const s = new FakeSocket();
  const r = new RunRecorder(10_000);
  const c = new TalosClient({ clientId: 'c1', traderId: 'T1', codec: 'json', socket: s, clock: realClock, recorder: r, ...over });
  return { c, s, r };
}

const delta = (serverTs: number, extra: Partial<Extract<ServerMsg, { t: 'delta' }>> = {}): ServerMsg => ({
  t: 'delta', seq: 1, serverTs, srcTs: serverTs - 40, updates: [], groupUpdates: [], adds: [], dirtyRoutes: [], rowCounts: [], newAbove: 0, ...extra,
});

describe('TalosClient hello', () => {
  it('sends hello as JSON text, then resolves on welcome', async () => {
    const { c, s } = setup();
    const p = c.hello('msgpack');
    expect(s.sent[0]).toEqual({ binary: false, msg: { t: 'hello', traderId: 'T1', codec: 'msgpack', clientId: 'c1' } });
    s.deliver(welcome());
    await expect(p).resolves.toBe(true);
    expect(c.codec).toBe('msgpack');
  });

  it('resolves false when no welcome arrives, and when the socket closes first', async () => {
    const { c, s } = setup();
    const p = c.hello(undefined, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe(false);
    const q = c.hello();
    s.serverClose(1006);
    await expect(q).resolves.toBe(false);
  });
});

describe('TalosClient getRows', () => {
  it('measures from the intended time, not from when the request was sent', async () => {
    const { c, s, r } = setup();
    const p = c.getRows(REQ, 9_700, true);
    const id = s.last('getRows')?.reqId as number;
    await vi.advanceTimersByTimeAsync(40);
    s.deliver({ t: 'rows', reqId: id, rows: [], rowCount: 5, ms: 12 });
    const out = await p;
    expect(out).toMatchObject({ ok: true, rowCount: 5, ms: 340 });
    expect(r.forCodec('json').rowsCold.values()).toEqual([340]);
    expect(r.forCodec('json').serverRowsCold.values()).toEqual([12]);
  });

  it('files a warm request apart from a cold one and uses the negotiated codec for the request frame', async () => {
    const { c, s, r } = setup();
    const hello = c.hello('msgpack');
    s.deliver(welcome());
    await hello;
    const p = c.getRows(REQ, 10_000, false);
    expect(s.sent.at(-1)?.binary).toBe(true);
    s.deliver({ t: 'rows', reqId: (s.last('getRows') as { reqId: number }).reqId, rows: [], rowCount: 0, ms: 1 }, 'msgpack');
    const out = await p;
    expect(out).toMatchObject({ ok: true, binary: true });
    expect(r.forCodec('msgpack').rowsWarm.count).toBe(1);
  });

  it('turns an error reply into a failure, and counts it', async () => {
    const { c, s, r } = setup();
    const p = c.getRows(REQ, 10_000, false);
    s.deliver({ t: 'error', reqId: (s.last('getRows') as { reqId: number }).reqId, code: 'UNKNOWN_COLUMN', message: 'x' });
    await expect(p).resolves.toMatchObject({ ok: false, code: 'UNKNOWN_COLUMN' });
    expect(r.errorCounts('json')).toEqual({ UNKNOWN_COLUMN: 1 });
  });

  it('times out an unanswered request and records the timeout as a latency, so it cannot hide', async () => {
    const { c, r } = setup();
    const p = c.getRows(REQ, 10_000, false);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(p).resolves.toMatchObject({ ok: false, code: 'TIMEOUT' });
    expect(r.forCodec('json').rowsWarm.values()).toEqual([15_000]);
    expect(r.errorCounts('json')).toEqual({ TIMEOUT: 1 });
  });

  it('fails pending requests when the socket closes, and refuses new ones', async () => {
    const { c, s } = setup();
    const p = c.getRows(REQ, 10_000, false);
    s.serverClose(1013);
    await expect(p).resolves.toMatchObject({ ok: false, code: 'CLOSED' });
    expect(c.closed).toBe(true);
    expect(c.closeCode).toBe(1013);
    await expect(c.getRows(REQ, 10_000, false)).resolves.toMatchObject({ code: 'CLOSED' });
  });

  it('records nothing for latency when the client is excluded (the slow consumer)', async () => {
    const { c, s, r } = setup({ excludeLatency: true });
    const p = c.getRows(REQ, 10_000, false);
    s.deliver({ t: 'rows', reqId: (s.last('getRows') as { reqId: number }).reqId, rows: [], rowCount: 0, ms: 1 });
    await p;
    s.deliver(delta(10_000));
    expect(r.forCodec('json').rowsWarm.count).toBe(0);
    expect(r.forCodec('json').delta.count).toBe(0);
  });
});

describe('TalosClient deltas and clock offset', () => {
  it('measures delta latency as receipt minus serverTs', () => {
    const { s, r } = setup();
    s.deliver(delta(9_950));
    expect(r.forCodec('json').delta.values()).toEqual([50]);
  });

  it('measures tick-to-screen from the source event (srcTs) and keeps the last hop from serverTs', () => {
    const { s, r } = setup();
    // The flush stamped the delta 30 ms ago; the event it carries happened 120 ms ago.
    s.deliver(delta(9_970, { srcTs: 9_880 }));
    expect(r.forCodec('json').delta.values()).toEqual([30]);
    expect(r.forCodec('json').deltaE2e.values()).toEqual([120]);
  });

  it('files the first view of a client as startup, a view change as cold and scrolling as warm', async () => {
    const { c, s, r } = setup();
    for (const kind of ['startup', true, false] as const) {
      const p = c.getRows(REQ, 10_000, kind);
      s.deliver({ t: 'rows', reqId: (s.last('getRows') as { reqId: number }).reqId, rows: [], rowCount: 0, ms: 1 });
      await p;
    }
    expect(r.forCodec('json').rowsStartup.count).toBe(1);
    expect(r.forCodec('json').rowsCold.count).toBe(1);
    expect(r.forCodec('json').rowsWarm.count).toBe(1);
  });

  it('corrects for a server clock that is ahead, using the ping with the lowest round trip', async () => {
    const { c, s, r } = setup();
    // Server clock is 500 ms ahead; one ping has a slow round trip and a wrong estimate, one a fast one.
    c.ping();
    await vi.advanceTimersByTimeAsync(200);
    s.deliver({ t: 'pong', ts: 10_000, serverTs: 10_000 + 500 + 150 });
    c.ping();
    await vi.advanceTimersByTimeAsync(4);
    s.deliver({ t: 'pong', ts: 10_200, serverTs: 10_200 + 500 + 2 });
    expect(c.clockOffsetMs).toBeCloseTo(500, 0);
    const now = Date.now();
    s.deliver(delta(now + 500 - 30));
    expect(r.forCodec('json').delta.values()[0]).toBeCloseTo(30, 0);
  });

  it('decodes by frame type: a binary frame is msgpack even while the client speaks JSON', () => {
    const { s, r } = setup();
    s.deliver(delta(9_990), 'msgpack');
    expect(r.forCodec('msgpack').delta.values()).toEqual([10]);
    expect(r.frameTotals('msgpack', 'in').byType.delta?.msgs).toBe(1);
  });

  it('counts a frame it cannot decode instead of throwing', () => {
    const { s, r } = setup();
    s.deliverRaw('not json');
    s.deliverRaw(new Uint8Array([0xc1]));
    expect(r.errorCounts('json')).toEqual({ CLIENT_BAD_FRAME: 1 });
    expect(r.errorCounts('msgpack')).toEqual({ CLIENT_BAD_FRAME: 1 });
  });

  it('tracks LIVE and PAUSED orders from rows, adds and updates, and forgets finished ones', async () => {
    const { c, s } = setup();
    const p = c.getRows(REQ, 10_000, false);
    s.deliver({ t: 'rows', reqId: (s.last('getRows') as { reqId: number }).reqId, rows: [{ orderId: 'A', status: 'LIVE' }, { orderId: 'B', status: 'FILLED' }], rowCount: 2, ms: 1 });
    await p;
    s.deliver(delta(10_000, { adds: [{ route: [], addIndex: 0, rows: [{ orderId: 'C', status: 'LIVE' } as never] }], updates: [{ route: [], rows: [{ orderId: 'A', status: 'PAUSED' }, { orderId: 'C', status: 'FILLED' }] }] }));
    expect([...c.liveOrders]).toEqual([['A', 'PAUSED']]);
  });
});

describe('TalosClient commands and control', () => {
  it('records ack latency from the intended time and resolves ack', async () => {
    const { c, s, r } = setup();
    const p = c.command('ORD1', 'PAUSE', 9_900);
    expect(s.last('command')).toMatchObject({ orderId: 'ORD1', action: 'PAUSE' });
    await vi.advanceTimersByTimeAsync(50);
    s.deliver({ t: 'ack', reqId: (s.last('command') as { reqId: number }).reqId });
    await expect(p).resolves.toBe('ack');
    expect(r.forCodec('json').commandAck.values()).toEqual([150]);
  });

  it('resolves the error code and counts a rejection', async () => {
    const { c, s, r } = setup();
    const p = c.command('ORD1', 'RESUME', 10_000);
    s.deliver({ t: 'error', reqId: (s.last('command') as { reqId: number }).reqId, code: 'INVALID_TRANSITION', message: 'no' });
    await expect(p).resolves.toBe('INVALID_TRANSITION');
    expect(Object.fromEntries(r.commandRejects)).toEqual({ INVALID_TRANSITION: 1 });
  });

  it('control resolves true on ack', async () => {
    const { c, s } = setup();
    const p = c.control('stress');
    expect(s.last('control')).toMatchObject({ preset: 'stress' });
    s.deliver({ t: 'ack', reqId: (s.last('control') as { reqId: number }).reqId });
    await expect(p).resolves.toBe(true);
  });
});

describe('TalosClient presets and slow consumer', () => {
  it('reports each change of load preset once, from welcome and summaries', () => {
    const seen: (string | null)[] = [];
    const { s } = setup({ onPreset: (p) => seen.push(p) });
    const summary = (preset: 'medium' | 'stress'): ServerMsg => ({ t: 'summary', byStatus: {} as never, liveNotionalUsd: 0, totalRows: 0, server: { cpu: 0, rssMb: 0, elLagMs: 0 }, preset });
    s.deliver(welcome(1, 'medium'));
    s.deliver(summary('medium'));
    s.deliver(summary('stress'));
    s.deliver(summary('stress'));
    s.deliver(summary('medium'));
    expect(seen).toEqual(['medium', 'stress', 'medium']);
  });

  it('notes the time of SLOW_CONSUMER even for an excluded client', () => {
    const { c, s, r } = setup({ excludeLatency: true });
    s.deliver({ t: 'error', code: 'SLOW_CONSUMER', message: 'behind' });
    expect(c.slowConsumerAt).toBe(Date.now());
    expect(r.errorCounts('json')).toEqual({ SLOW_CONSUMER: 1 });
  });

  it('can pause and resume reading', () => {
    const { c, s } = setup();
    c.pauseReading();
    expect(s.paused).toBe(true);
    c.resumeReading();
    expect(s.paused).toBe(false);
  });
});
