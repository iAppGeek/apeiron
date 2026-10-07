import { describe, expect, it } from 'vitest';
import { RunRecorder } from './recorder.js';

describe('RunRecorder', () => {
  it('keeps latencies per codec, cold apart from warm, with times relative to the run start', () => {
    const r = new RunRecorder(1_000);
    r.rows({ codec: 'json', cold: true, at: 3_000, ms: 120, serverMs: 100 });
    r.rows({ codec: 'json', cold: false, at: 4_000, ms: 5, serverMs: 2 });
    r.rows({ codec: 'msgpack', cold: false, at: 5_000, ms: 4, serverMs: 2 });
    expect(r.codecs()).toEqual(['json', 'msgpack']);
    expect(r.forCodec('json').rowsCold.values()).toEqual([120]);
    expect(r.forCodec('json').rowsWarm.summary(3_000)?.p50).toBe(5);
    expect(r.forCodec('json').rowsWarm.summary(0, 3_000)).toBeNull();
    expect(r.forCodec('json').serverRowsCold.values()).toEqual([100]);
    expect(r.forCodec('json').serverRowsWarm.values()).toEqual([2]);
  });

  it('totals frames by codec, direction and type', () => {
    const r = new RunRecorder(0);
    r.frame({ codec: 'json', direction: 'in', type: 'delta', bytes: 100 });
    r.frame({ codec: 'json', direction: 'in', type: 'delta', bytes: 50 });
    r.frame({ codec: 'json', direction: 'in', type: 'rows', bytes: 1000 });
    r.frame({ codec: 'json', direction: 'out', type: 'getRows', bytes: 300 });
    r.frame({ codec: 'msgpack', direction: 'in', type: 'delta', bytes: 7 });
    const t = r.frameTotals('json', 'in');
    expect(t.total).toEqual({ msgs: 3, bytes: 1150 });
    expect(t.byType.delta).toEqual({ msgs: 2, bytes: 150 });
    expect(r.frameTotals('json', 'out').total.bytes).toBe(300);
    expect(r.frameTotals('msgpack', 'out').total).toEqual({ msgs: 0, bytes: 0 });
  });

  it('counts errors by code and command rejections apart from acks', () => {
    const r = new RunRecorder(0);
    r.error({ codec: 'json', code: 'BAD_MESSAGE', at: 1 });
    r.error({ codec: 'json', code: 'BAD_MESSAGE', at: 2 });
    r.error({ codec: 'msgpack', code: 'INTERNAL', at: 2 });
    expect(r.errorCounts('json')).toEqual({ BAD_MESSAGE: 2 });
    r.command({ codec: 'json', at: 5, ms: 40, ok: true });
    r.command({ codec: 'json', at: 6, ms: 3, ok: false, code: 'INVALID_TRANSITION' });
    expect(r.forCodec('json').commandAck.values()).toEqual([40]);
    expect(Object.fromEntries(r.commandRejects)).toEqual({ INVALID_TRANSITION: 1 });
  });

  it('records counters, send lag and events', () => {
    const r = new RunRecorder(100);
    r.count('scrolls');
    r.count('scrolls');
    r.sendLag(150, 3);
    r.event('slow.paused', 600, { a: 1 });
    expect(r.counters.scrolls).toBe(2);
    expect(r.sendLags.values()).toEqual([3]);
    expect(r.events).toEqual([{ t: 500, name: 'slow.paused', detail: { a: 1 } }]);
  });
});
