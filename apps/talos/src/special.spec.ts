import type { ClientMsg } from '@apeiron/logos';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TalosClient } from './client.js';
import { RunRecorder } from './recorder.js';
import { realClock } from './schedule.js';
import { runCodecSwitcher, runSlowConsumer, runStressWindow } from './special.js';
import type { ViewSpec } from './scenario.js';
import { FakeSocket, autoServer, type AutoServerOptions } from './testing/fake-socket.js';

afterEach(() => vi.useRealTimers());

const VIEW: ViewSpec = { rowGroupCols: [], valueCols: [], sortModel: [], filterModel: null };

function make(server: AutoServerOptions = {}, excludeLatency = false): { client: TalosClient; socket: FakeSocket; recorder: RunRecorder; seen: ClientMsg[] } {
  vi.useFakeTimers({ now: 5_000_000 });
  const socket = new FakeSocket();
  const seen: ClientMsg[] = [];
  autoServer(socket, { ...server, seen: (m) => seen.push(m) });
  const recorder = new RunRecorder(Date.now());
  const client = new TalosClient({ clientId: 'c', traderId: 'ALL', codec: 'json', socket, clock: realClock, recorder, excludeLatency });
  return { client, socket, recorder, seen };
}

describe('runCodecSwitcher', () => {
  it('re-sends hello with the other codec every period and checks getRows in the right frame type', async () => {
    const { client, socket, recorder, seen } = make();
    await Promise.all([client.hello('json'), Promise.resolve()]);
    const start = Date.now();
    const done = runCodecSwitcher({ client, clock: realClock, recorder, view: () => VIEW, startMs: start, endMs: start + 70_000, everyMs: 20_000, stopped: () => false });
    await vi.advanceTimersByTimeAsync(70_000);
    await done;
    const switches = recorder.events.filter((e) => e.name === 'codec.switch');
    expect(switches.map((e) => e.detail.to)).toEqual(['msgpack', 'json', 'msgpack']);
    expect(switches.every((e) => e.detail.welcomed === true && e.detail.getRowsOk === true && e.detail.frameTypeOk === true)).toBe(true);
    expect(switches.map((e) => Math.round(e.t / 1000))).toEqual([20, 40, 60]);
    // Every hello is JSON text, and the getRows after a switch uses the new codec.
    const hellos = socket.sent.filter((f) => f.msg.t === 'hello');
    expect(hellos.every((f) => !f.binary)).toBe(true);
    expect(seen.filter((m) => m.t === 'hello').map((m) => (m as { codec: string }).codec)).toEqual(['json', 'msgpack', 'json', 'msgpack']);
    const afterFirstSwitch = socket.sent.findIndex((f) => f.msg.t === 'hello' && (f.msg as { codec: string }).codec === 'msgpack');
    expect(socket.sent[afterFirstSwitch + 1]).toMatchObject({ binary: true });
  });

  it('flags a switch whose getRows fails or comes back in the wrong frame type', async () => {
    const { client, socket, recorder } = make();
    socket.onSend = ({ msg }, s): void => {
      if (msg.t === 'hello') s.deliver({ t: 'welcome', serverTime: 1, traders: [], columnsVersion: 'x', preset: null });
      // Answers getRows in JSON text even though msgpack was negotiated.
      if (msg.t === 'getRows') s.deliver({ t: 'rows', reqId: msg.reqId, rows: [], rowCount: 0, ms: 1 }, 'json');
    };
    await client.hello('json');
    const start = Date.now();
    const done = runCodecSwitcher({ client, clock: realClock, recorder, view: () => VIEW, startMs: start, endMs: start + 25_000, everyMs: 20_000, stopped: () => false });
    await vi.advanceTimersByTimeAsync(25_000);
    await done;
    expect(recorder.events.find((e) => e.name === 'codec.switch')?.detail).toMatchObject({ to: 'msgpack', getRowsOk: true, frameTypeOk: false });
  });

  it('records a failed switch when the server rejects getRows', async () => {
    const { client, socket, recorder } = make();
    socket.onSend = ({ msg }, s): void => {
      if (msg.t === 'hello') s.deliver({ t: 'welcome', serverTime: 1, traders: [], columnsVersion: 'x', preset: null });
      if (msg.t === 'getRows') s.deliver({ t: 'error', reqId: msg.reqId, code: 'BAD_FRAME', message: 'x' }, 'msgpack');
    };
    await client.hello('json');
    const start = Date.now();
    const done = runCodecSwitcher({ client, clock: realClock, recorder, view: () => VIEW, startMs: start, endMs: start + 25_000, everyMs: 20_000, stopped: () => false });
    await vi.advanceTimersByTimeAsync(25_000);
    await done;
    expect(recorder.events[0]?.detail).toMatchObject({ getRowsOk: false, code: 'BAD_FRAME' });
  });
});

describe('runStressWindow', () => {
  it('asks for stress at the start of the window and medium at its end', async () => {
    const { client, recorder, seen } = make();
    await Promise.all([client.hello(), Promise.resolve()]);
    const start = Date.now();
    const done = runStressWindow({ client, clock: realClock, recorder, startAtMs: start + 10_000, durationMs: 60_000, endMs: start + 200_000, stopped: () => false });
    await vi.advanceTimersByTimeAsync(80_000);
    await done;
    expect(seen.filter((m) => m.t === 'control').map((m) => (m as { preset: string }).preset)).toEqual(['stress', 'medium']);
    const [on, off] = recorder.events.filter((e) => e.name.startsWith('stress.'));
    expect(on?.name).toBe('stress.stress');
    expect(Math.round((on?.t ?? 0) / 1000)).toBe(10);
    expect(Math.round((off?.t ?? 0) / 1000)).toBe(70);
    expect(on?.detail.acked).toBe(true);
  });

  it('goes back to medium even when the run ends inside the window', async () => {
    const { client, recorder, seen } = make();
    await Promise.all([client.hello(), Promise.resolve()]);
    const start = Date.now();
    const done = runStressWindow({ client, clock: realClock, recorder, startAtMs: start, durationMs: 60_000, endMs: start + 5_000, stopped: () => false });
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(seen.filter((m) => m.t === 'control').map((m) => (m as { preset: string }).preset)).toEqual(['stress', 'medium']);
  });

  it('does nothing if stopped before the window opens', async () => {
    const { client, recorder, seen } = make();
    const start = Date.now();
    const done = runStressWindow({ client, clock: realClock, recorder, startAtMs: start + 50_000, durationMs: 60_000, endMs: start + 200_000, stopped: () => true });
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(seen.some((m) => m.t === 'control')).toBe(false);
  });
});

describe('runSlowConsumer', () => {
  /** Answers hello and ordinary requests, and never answers the big requests (they would sit unread behind the paused socket). */
  function slowServer(socket: FakeSocket): void {
    socket.onSend = ({ msg }, s): void => {
      if (msg.t === 'hello') s.deliver({ t: 'welcome', serverTime: 1, traders: [], columnsVersion: 'x', preset: null });
      if (msg.t !== 'getRows') return;
      if (msg.req.endRow - msg.req.startRow > 1000) {
        return;
      }
      s.deliver({ t: 'rows', reqId: msg.reqId, rows: [], rowCount: 5, ms: 1 });
    };
  }

  it('stops reading at the pause time and sends big requests until the server closes it, then reads the SLOW_CONSUMER error and reconnects', async () => {
    const { client, socket, recorder } = make({}, true);
    slowServer(socket);
    let serverClosed = false;
    const again = make();
    autoServer(again.socket);
    const start = Date.now();
    const done = runSlowConsumer({
      client,
      clock: realClock,
      recorder,
      pauseAtMs: start + 10_000,
      endMs: start + 300_000,
      serverClosedIt: () => serverClosed,
      stopped: () => false,
      connect: async () => again.client,
    });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(socket.paused).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(socket.paused).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    const fills = socket.sent.filter((f) => f.msg.t === 'getRows' && f.msg.req.endRow > 1000).length;
    expect(fills).toBeGreaterThanOrEqual(3);
    // The server closes it: SLOW_CONSUMER, then the close, both stuck behind the paused socket until it resumes.
    serverClosed = true;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(socket.paused).toBe(false);
    socket.deliver({ t: 'error', code: 'SLOW_CONSUMER', message: 'behind' });
    socket.serverClose(1013);
    await vi.advanceTimersByTimeAsync(5_000);
    await done;
    const names = recorder.events.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['slow.paused', 'slow.server_closed_seen', 'slow.resumed', 'slow.after_resume', 'slow.error_received', 'slow.reconnect']));
    expect(recorder.events.find((e) => e.name === 'slow.after_resume')?.detail).toMatchObject({ slowConsumerError: true, closed: true, closeCode: 1013 });
    expect(recorder.events.find((e) => e.name === 'slow.reconnect')?.detail).toMatchObject({ ok: true });
    expect(recorder.errorCounts('json')).toEqual({ SLOW_CONSUMER: 1 });
    // The slow consumer's own latencies are excluded from the aggregates.
    expect(recorder.forCodec('json').rowsWarm.count + recorder.forCodec('json').rowsCold.count).toBe(0);
  });

  it('resumes after the longest pause when the server never closes it, and closes its own socket', async () => {
    const { client, socket, recorder } = make({}, true);
    slowServer(socket);
    const start = Date.now();
    const done = runSlowConsumer({
      client,
      clock: realClock,
      recorder,
      pauseAtMs: start + 1_000,
      endMs: start + 300_000,
      maxPauseMs: 8_000,
      serverClosedIt: () => false,
      stopped: () => false,
      connect: async () => null,
    });
    await vi.advanceTimersByTimeAsync(40_000);
    await done;
    expect(recorder.events.find((e) => e.name === 'slow.resumed')?.detail.pausedMs).toBeGreaterThanOrEqual(8_000);
    expect(recorder.events.find((e) => e.name === 'slow.after_resume')?.detail).toMatchObject({ slowConsumerError: false, closed: false });
    expect(socket.closedWith).toBe(1000);
  });

  it('does not pause if the run is stopped first', async () => {
    const { client, socket, recorder } = make({}, true);
    slowServer(socket);
    const start = Date.now();
    let stop = false;
    const done = runSlowConsumer({ client, clock: realClock, recorder, pauseAtMs: start + 100_000, endMs: start + 300_000, serverClosedIt: () => false, stopped: () => stop, connect: async () => null });
    await vi.advanceTimersByTimeAsync(2_000);
    stop = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await done;
    expect(socket.paused).toBe(false);
    expect(recorder.events).toEqual([]);
  });
});
