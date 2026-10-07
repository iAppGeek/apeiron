import type { ServerMsg, SsrmRequest } from '@apeiron/logos';
import { describe, expect, it, vi } from 'vitest';
import { RequestError, createBlotterClient, type WorkerLike } from './client';
import type { MainToWorker, WorkerToMain } from './messages';

type FakeWorker = WorkerLike & { posted: MainToWorker[]; reply: (m: WorkerToMain) => void; terminate: ReturnType<typeof vi.fn<() => void>> };
const makeWorker = (): FakeWorker => {
  const w: FakeWorker = {
    posted: [],
    postMessage: (m) => {
      w.posted.push(m);
    },
    onmessage: null,
    terminate: vi.fn<() => void>(),
    reply: (data) => w.onmessage?.({ data }),
  };
  return w;
};

const req: SsrmRequest = { startRow: 0, endRow: 100, rowGroupCols: [], valueCols: [], groupKeys: [], sortModel: [] };
const welcome: Extract<ServerMsg, { t: 'welcome' }> = { t: 'welcome', serverTime: 1, traders: [], columnsVersion: 'v', preset: null };

const lastRequestId = (w: FakeWorker): number => {
  const m = w.posted.at(-1);
  if (m?.kind !== 'request') throw new Error('no request');
  return m.msg.reqId;
};

describe('createBlotterClient', () => {
  it('posts connect', () => {
    const w = makeWorker();
    createBlotterClient(w).connect('ws://x/ws');
    expect(w.posted).toEqual([{ kind: 'connect', url: 'ws://x/ws' }]);
  });

  it('resolves getRows with the rows result', async () => {
    const w = makeWorker();
    const client = createBlotterClient(w);
    const p = client.getRows(req);
    expect(w.posted[0]).toMatchObject({ kind: 'request', msg: { t: 'getRows', req } });
    const reqId = lastRequestId(w);
    w.reply({ kind: 'response', reqId, ok: true, msg: { t: 'rows', reqId, rows: [{ orderId: 'A' }], rowCount: 9, ms: 3 } });
    await expect(p).resolves.toEqual({ rows: [{ orderId: 'A' }], rowCount: 9, ms: 3 });
  });

  it('gives concurrent requests distinct ids and matches replies by id', async () => {
    const w = makeWorker();
    const client = createBlotterClient(w);
    const a = client.getRows(req);
    const idA = lastRequestId(w);
    const b = client.setFilterValues('venue');
    const idB = lastRequestId(w);
    expect(idA).not.toBe(idB);
    w.reply({ kind: 'response', reqId: idB, ok: true, msg: { t: 'filterValues', reqId: idB, values: ['EBS'] } });
    w.reply({ kind: 'response', reqId: idA, ok: true, msg: { t: 'rows', reqId: idA, rows: [], rowCount: 0, ms: 1 } });
    await expect(b).resolves.toEqual(['EBS']);
    await expect(a).resolves.toMatchObject({ rowCount: 0 });
  });

  it('rejects with a RequestError carrying the server code', async () => {
    const w = makeWorker();
    const p = createBlotterClient(w).getRows(req);
    w.reply({ kind: 'response', reqId: lastRequestId(w), ok: false, code: 'NOT_READY', message: 'loading' });
    await expect(p).rejects.toMatchObject({ name: 'RequestError', code: 'NOT_READY', message: 'loading' });
    await expect(p).rejects.toBeInstanceOf(RequestError);
  });

  it('rejects when the reply has the wrong type', async () => {
    const w = makeWorker();
    const p = createBlotterClient(w).getRows(req);
    const reqId = lastRequestId(w);
    w.reply({ kind: 'response', reqId, ok: true, msg: { t: 'ack', reqId } });
    await expect(p).rejects.toMatchObject({ code: 'INTERNAL' });
    const q = createBlotterClient(w).setFilterValues('x');
    const id2 = lastRequestId(w);
    w.reply({ kind: 'response', reqId: id2, ok: true, msg: { t: 'ack', reqId: id2 } });
    await expect(q).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('resolves hello with the welcome and rejects on error', async () => {
    const w = makeWorker();
    const client = createBlotterClient(w);
    const ok = client.hello('T1', 'msgpack');
    const first = w.posted.at(-1);
    expect(first).toMatchObject({ kind: 'hello', traderId: 'T1', codec: 'msgpack' });
    const bad = client.hello('NOPE', 'json');
    const second = w.posted.at(-1);
    if (first?.kind !== 'hello' || second?.kind !== 'hello') throw new Error('expected hellos');
    w.reply({ kind: 'hello-result', id: first.id, ok: true, welcome });
    w.reply({ kind: 'hello-result', id: second.id, ok: false, code: 'UNKNOWN_TRADER', message: 'no' });
    await expect(ok).resolves.toEqual(welcome);
    await expect(bad).rejects.toMatchObject({ code: 'UNKNOWN_TRADER' });
  });

  it('delivers status, message and stats events and supports unsubscribe', () => {
    const w = makeWorker();
    const client = createBlotterClient(w);
    const status = vi.fn();
    const message = vi.fn();
    const stats = vi.fn();
    const off = client.on('status', status);
    client.on('message', message);
    client.on('stats', stats);
    w.reply({ kind: 'status', status: 'connected', attempt: 0, codec: 'json' });
    w.reply({ kind: 'message', msg: welcome });
    w.reply({ kind: 'stats', msgsIn: 1, msgsOut: 2, deltasIn: 4, rttMs: 3, clockOffsetMs: 5 });
    expect(status).toHaveBeenCalledWith({ status: 'connected', attempt: 0, codec: 'json' });
    expect(message).toHaveBeenCalledWith(welcome);
    expect(stats).toHaveBeenCalledWith({ msgsIn: 1, msgsOut: 2, deltasIn: 4, rttMs: 3, clockOffsetMs: 5 });
    off();
    w.reply({ kind: 'status', status: 'closed', attempt: 0, codec: 'json' });
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('ignores replies for unknown ids', () => {
    const w = makeWorker();
    createBlotterClient(w);
    expect(() => {
      w.reply({ kind: 'response', reqId: 999, ok: false, code: 'INTERNAL', message: 'x' });
      w.reply({ kind: 'hello-result', id: 999, ok: false, code: 'INTERNAL', message: 'x' });
    }).not.toThrow();
  });

  it('dispose closes the worker and rejects what is still pending', async () => {
    const w = makeWorker();
    const client = createBlotterClient(w);
    const p = client.getRows(req);
    const h = client.hello('ALL', 'json');
    client.dispose();
    expect(w.posted.at(-1)).toEqual({ kind: 'close' });
    expect(w.terminate).toHaveBeenCalled();
    await expect(p).rejects.toMatchObject({ code: 'DISCONNECTED' });
    await expect(h).rejects.toMatchObject({ code: 'DISCONNECTED' });
  });

  it('control sends the preset and resolves on the ack', async () => {
    const w = makeWorker();
    const p = createBlotterClient(w).control('stress');
    expect(w.posted[0]).toMatchObject({ kind: 'request', msg: { t: 'control', preset: 'stress' } });
    const reqId = lastRequestId(w);
    w.reply({ kind: 'response', reqId, ok: true, msg: { t: 'ack', reqId } });
    await expect(p).resolves.toBeUndefined();
  });

  it('control rejects with the server code', async () => {
    const w = makeWorker();
    const p = createBlotterClient(w).control('medium');
    const reqId = lastRequestId(w);
    w.reply({ kind: 'response', reqId, ok: false, code: 'NOT_IMPLEMENTED', message: 'no bus' });
    await expect(p).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
  });

  it('control rejects on an unexpected reply', async () => {
    const w = makeWorker();
    const p = createBlotterClient(w).control('medium');
    const reqId = lastRequestId(w);
    w.reply({ kind: 'response', reqId, ok: true, msg: { t: 'filterValues', reqId, values: [] } });
    await expect(p).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('delivers the close code of an unexpected close', () => {
    const w = makeWorker();
    const client = createBlotterClient(w);
    const closed = vi.fn();
    client.on('closed', closed);
    w.reply({ kind: 'closed', code: 1013 });
    expect(closed).toHaveBeenCalledWith({ code: 1013 });
  });
});
