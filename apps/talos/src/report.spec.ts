import { describe, expect, it } from 'vitest';
import { parseProm } from './prom.js';
import { RunRecorder } from './recorder.js';
import { buildReport, evaluateTargets, serverHistograms, type CodecReport, type Meta } from './report.js';
import type { ResourceReport } from './scraper.js';
import { summarize } from './stats.js';

const meta: Meta = { startedAt: '2026-10-07T00:00:00.000Z', durationS: 100, clients: 4, codec: 'both', url: 'ws://x', metricsUrl: null, seed: 1, options: {} };

function recorder(): RunRecorder {
  const r = new RunRecorder(0);
  for (let i = 1; i <= 100; i++) r.rows({ codec: 'json', kind: 'warm', at: i * 100, ms: i, serverMs: 1 });
  r.rows({ codec: 'json', kind: 'cold', at: 15_000, ms: 250, serverMs: 200 });
  for (let i = 0; i < 10; i++) r.delta({ codec: 'json', at: 10_000 + i * 10_000, ms: 10 + i, e2eMs: 10 + i + 100 });
  r.delta({ codec: 'json', at: 50_000, ms: 900, e2eMs: 900 + 100 });
  r.command({ codec: 'json', at: 20_000, ms: 80, ok: true });
  r.frame({ codec: 'json', direction: 'in', type: 'delta', bytes: 8_000 });
  r.frame({ codec: 'json', direction: 'in', type: 'rows', bytes: 2_000 });
  r.frame({ codec: 'json', direction: 'out', type: 'getRows', bytes: 400 });
  r.rows({ codec: 'msgpack', kind: 'warm', at: 1_000, ms: 3, serverMs: 1 });
  r.error({ codec: 'msgpack', code: 'TIMEOUT', at: 1 });
  return r;
}

describe('buildReport', () => {
  const report = buildReport({
    meta,
    recorder: recorder(),
    clientsByCodec: { msgpack: 2, json: 2 },
    phases: { stressFromS: 40, stressToS: 60 },
    resources: null,
    first: null,
    last: null,
    lagCumulative: null,
  });

  it('reports cold apart from warm per codec, with nearest-rank percentiles', () => {
    const json = report.codecs.find((c) => c.codec === 'json') as CodecReport;
    expect(json.getRows.warm).toMatchObject({ count: 100, p50: 50, p95: 95, p99: 99, max: 100 });
    expect(json.getRows.cold).toMatchObject({ count: 1, p50: 250 });
    expect(json.getRows.serverReportedWarm?.max).toBe(1);
    expect(json.getRows.serverReportedCold?.max).toBe(200);
    expect(json.commandAck?.p50).toBe(80);
    expect(report.codecs.map((c) => c.codec)).toEqual(['json', 'msgpack']);
  });

  it('splits delta latency into before, during and after the stress window', () => {
    const json = report.codecs[0] as CodecReport;
    expect(json.deltaByPhase?.baseline).toMatchObject({ count: 3, max: 12 });
    expect(json.deltaByPhase?.stress).toMatchObject({ count: 3, max: 900 });
    expect(json.deltaByPhase?.after?.count).toBe(5);
    expect(json.delta?.count).toBe(11);
  });

  it('normalises traffic to messages and bytes per client per second', () => {
    const json = report.codecs[0] as CodecReport;
    expect(json.perClient.bytesInPerSec).toBeCloseTo(10_000 / 2 / 100, 9);
    expect(json.perClient.msgsInPerSec).toBeCloseTo(2 / 2 / 100, 9);
    expect(json.perClient.msgsOutPerSec).toBeCloseTo(1 / 2 / 100, 9);
    expect(json.perClient.bytesInByType.delta).toBeCloseTo(8_000 / 200, 9);
  });

  it('carries errors by code per codec and leaves phases out when there is no stress window', () => {
    expect(report.codecs[1]?.errors).toEqual({ TIMEOUT: 1 });
    const flat = buildReport({ meta, recorder: recorder(), clientsByCodec: { json: 1 }, phases: null, resources: null, first: null, last: null, lagCumulative: null });
    expect(flat.codecs[0]?.deltaByPhase).toBeNull();
  });
});

describe('serverHistograms', () => {
  const before = parseProm(`apeiron_flush_duration_seconds_bucket{le="0.001"} 0
apeiron_flush_duration_seconds_bucket{le="0.01"} 0
apeiron_flush_duration_seconds_bucket{le="+Inf"} 0
apeiron_backpressure_events_total{event="soft_conflate"} 2`);
  const after = parseProm(`apeiron_flush_duration_seconds_bucket{le="0.001"} 50
apeiron_flush_duration_seconds_bucket{le="0.01"} 100
apeiron_flush_duration_seconds_bucket{le="+Inf"} 100
apeiron_getrows_duration_seconds_bucket{le="0.05",temp="warm",shape="flat"} 10
apeiron_getrows_duration_seconds_bucket{le="+Inf",temp="warm",shape="flat"} 10
apeiron_getrows_duration_seconds_count{temp="warm",shape="flat"} 10
apeiron_backpressure_events_total{event="soft_conflate"} 12
apeiron_backpressure_events_total{event="slow_consumer"} 1`);

  it('turns the run-long histogram and counter deltas into milliseconds and counts', () => {
    const h = serverHistograms(before, after);
    expect(h.flushP50Ms).toBeCloseTo(1, 6);
    expect(h.flushP99Ms).toBeCloseTo(9.82, 6);
    expect(h.getRowsWarmCount).toBe(10);
    expect(h.getRowsWarmP95Ms).toBeCloseTo(47.5, 6);
    expect(h.getRowsColdP95Ms).toBeNull();
    expect(h.softConflates).toBe(10);
    expect(h.slowConsumers).toBe(1);
  });
});

describe('evaluateTargets', () => {
  const codec = (codec: 'json' | 'msgpack', warm: number, cold: number, delta: number): CodecReport => ({
    codec,
    clients: 1,
    getRows: { warm: summarize([warm]), cold: summarize([cold]), startup: null, serverReportedCold: null, serverReportedWarm: null },
    delta: summarize([delta / 5]),
    deltaByPhase: null,
    tickToScreen: summarize([delta]),
    tickToScreenByPhase: null,
    commandAck: null,
    perClient: { msgsInPerSec: 0, bytesInPerSec: 0, msgsOutPerSec: 0, bytesOutPerSec: 0, bytesInByType: {} },
    errors: {},
  });
  const server = (rss: number, lag: number): ResourceReport => ({
    cpuPercent: null,
    rssMb: { min: rss, median: rss, max: rss, samples: 1 },
    heapUsedMb: null,
    eventLoopLagP99Ms: { min: 1, median: 1, max: lag, samples: 1 },
    eventLoopLagMaxMs: null,
    scrapes: 1,
    failures: 0,
  });

  it('gates the end-to-end tick-to-screen figure, not the last hop', () => {
    const slowEndToEnd = codec('json', 10, 100, 160);
    expect(slowEndToEnd.delta?.p95).toBeLessThan(150);
    const t = evaluateTargets([slowEndToEnd], server(900, 5), null);
    expect(t[2]).toMatchObject({ name: expect.stringContaining('Tick-to-screen'), values: { json: 160 }, pass: false });
  });

  it('passes when every figure is under its limit', () => {
    const t = evaluateTargets([codec('json', 10, 100, 20)], server(900, 5), null);
    expect(t.map((x) => x.pass)).toEqual([true, true, true, true, true]);
  });

  it('fails a target when any codec is over it, and names the codec', () => {
    const t = evaluateTargets([codec('json', 10, 100, 20), codec('msgpack', 60, 400, 200)], server(2100, 80), null);
    expect(t.map((x) => x.pass)).toEqual([false, false, false, false, false]);
    expect(t[0]?.values).toEqual({ json: 10, msgpack: 60 });
  });

  it('prefers the whole-run lag histogram over the 1s-window figures, and is n/a without data', () => {
    expect(evaluateTargets([codec('json', 1, 1, 1)], server(1, 80), { p50: 1, p99: 12, p999: 40, max: 90, samples: 100 })[3]).toMatchObject({ values: { all: 12 }, pass: true });
    const none = evaluateTargets([], null, null);
    expect(none.every((x) => x.pass === null)).toBe(true);
  });
});

describe('startup burst, tick-to-screen and start state in the report', () => {
  const r = new RunRecorder(0);
  r.rows({ codec: 'json', kind: 'startup', at: 500, ms: 900, serverMs: 30 });
  r.rows({ codec: 'json', kind: 'startup', at: 700, ms: 1500, serverMs: 30 });
  r.rows({ codec: 'json', kind: 'cold', at: 4_000, ms: 800, serverMs: 30 });
  r.rows({ codec: 'json', kind: 'cold', at: 20_000, ms: 60, serverMs: 30 });
  r.delta({ codec: 'json', at: 30_000, ms: 20, e2eMs: 90 });
  const report = buildReport({
    meta,
    recorder: r,
    clientsByCodec: { json: 2 },
    phases: null,
    resources: null,
    first: parseProm('apeiron_live_rows 593\napeiron_store_rows 1000234\n'),
    last: null,
    lagCumulative: { p50: 1, p99: 5, p999: 12, max: 60, samples: 10 },
  });

  it('reports the first view of every client apart from view changes, and leaves the first 10 s out of the latter', () => {
    const json = report.codecs[0] as CodecReport;
    expect(json.getRows.startup).toMatchObject({ count: 2, p50: 900, max: 1500 });
    expect(json.getRows.cold).toMatchObject({ count: 1, max: 60 });
  });

  it('reports tick-to-screen (source event to receipt) apart from the last hop', () => {
    const json = report.codecs[0] as CodecReport;
    expect(json.tickToScreen?.p95).toBe(90);
    expect(json.delta?.p95).toBe(20);
  });

  it('records what the server held when the run began', () => {
    expect(report.start).toEqual({ liveRows: 593, storeRows: 1_000_234 });
    expect(report.eventLoopLagCumulative?.p999).toBe(12);
  });
});
