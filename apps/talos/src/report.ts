import type { CodecName } from '@apeiron/logos';
import { histogramDelta, histogramQuantile, sumOf, type Sample } from './prom.js';
import type { RunRecorder, FrameTotals, RunEvent } from './recorder.js';
import type { ResourceReport } from './scraper.js';
import type { Summary } from './stats.js';

export type Phases = { stressFromS: number; stressToS: number };

export type Meta = {
  startedAt: string;
  durationS: number;
  clients: number;
  codec: string;
  url: string;
  metricsUrl: string | null;
  seed: number;
  options: Record<string, unknown>;
};

export type DeltaPhases = { baseline: Summary | null; stress: Summary | null; after: Summary | null };

export type CodecReport = {
  codec: CodecName;
  clients: number;
  getRows: { cold: Summary | null; warm: Summary | null; serverReportedCold: Summary | null; serverReportedWarm: Summary | null };
  delta: Summary | null;
  deltaByPhase: DeltaPhases | null;
  commandAck: Summary | null;
  perClient: {
    msgsInPerSec: number;
    bytesInPerSec: number;
    msgsOutPerSec: number;
    bytesOutPerSec: number;
    bytesInByType: Record<string, number>;
  };
  errors: Record<string, number>;
};

/** Server-side figures taken from the histogram and counter deltas between the first and last scrape. */
export type ServerHistograms = {
  getRowsWarmP95Ms: number | null;
  getRowsColdP95Ms: number | null;
  getRowsColdCount: number;
  getRowsWarmCount: number;
  flushP50Ms: number | null;
  flushP99Ms: number | null;
  eventAgeP95Ms: number | null;
  deltaBytesP95: number | null;
  commandP95Ms: number | null;
  softConflates: number;
  slowConsumers: number;
};

export type LagCumulative = { p50: number; p99: number; max: number; samples: number };

export type TargetResult = {
  name: string;
  target: string;
  /** Measured value per codec, or a single `all` entry for server-wide figures. */
  values: Record<string, number | null>;
  unit: string;
  pass: boolean | null;
};

export type Report = {
  meta: Meta;
  phases: Phases | null;
  codecs: CodecReport[];
  server: ResourceReport | null;
  serverHistograms: ServerHistograms | null;
  eventLoopLagCumulative: LagCumulative | null;
  generator: { sendLagMs: Summary | null; eventLoopLagMs: { p99: number; max: number } | null; note: string };
  counters: Record<string, number>;
  commandRejects: Record<string, number>;
  events: RunEvent[];
  targets: TargetResult[];
};

const ms = (v: number): number | null => (Number.isNaN(v) ? null : v * 1000);

export function serverHistograms(first: readonly Sample[], last: readonly Sample[]): ServerHistograms {
  const warm = histogramDelta(first, last, 'apeiron_getrows_duration_seconds', { temp: 'warm' });
  const cold = histogramDelta(first, last, 'apeiron_getrows_duration_seconds', { temp: 'cold' });
  const flush = histogramDelta(first, last, 'apeiron_flush_duration_seconds');
  const age = histogramDelta(first, last, 'apeiron_event_age_at_flush_seconds');
  const delta = histogramDelta(first, last, 'apeiron_delta_bytes');
  const command = histogramDelta(first, last, 'apeiron_command_duration_seconds', { outcome: 'ok' });
  const grew = (event: string): number => Math.max(0, sumOf(last, 'apeiron_backpressure_events_total', { event }) - sumOf(first, 'apeiron_backpressure_events_total', { event }));
  const bytes = histogramQuantile(delta, 0.95);
  return {
    getRowsWarmP95Ms: ms(histogramQuantile(warm, 0.95)),
    getRowsColdP95Ms: ms(histogramQuantile(cold, 0.95)),
    getRowsColdCount: cold.count,
    getRowsWarmCount: warm.count,
    flushP50Ms: ms(histogramQuantile(flush, 0.5)),
    flushP99Ms: ms(histogramQuantile(flush, 0.99)),
    eventAgeP95Ms: ms(histogramQuantile(age, 0.95)),
    deltaBytesP95: Number.isNaN(bytes) ? null : bytes,
    commandP95Ms: ms(histogramQuantile(command, 0.95)),
    softConflates: grew('soft_conflate'),
    slowConsumers: grew('slow_consumer'),
  };
}

function codecReport(recorder: RunRecorder, codec: CodecName, clients: number, durationS: number, phases: Phases | null): CodecReport {
  const s = recorder.forCodec(codec);
  const inT = recorder.frameTotals(codec, 'in');
  const outT = recorder.frameTotals(codec, 'out');
  const per = (n: number): number => (clients === 0 || durationS === 0 ? 0 : n / clients / durationS);
  const bytesInByType: Record<string, number> = {};
  for (const [type, t] of Object.entries(inT.byType) as [string, FrameTotals][]) bytesInByType[type] = per(t.bytes);
  const from = phases === null ? 0 : phases.stressFromS * 1000;
  const to = phases === null ? 0 : phases.stressToS * 1000;
  return {
    codec,
    clients,
    getRows: {
      cold: s.rowsCold.summary(),
      warm: s.rowsWarm.summary(),
      serverReportedCold: s.serverRowsCold.summary(),
      serverReportedWarm: s.serverRowsWarm.summary(),
    },
    delta: s.delta.summary(),
    deltaByPhase: phases === null ? null : { baseline: s.delta.summary(-Infinity, from), stress: s.delta.summary(from, to), after: s.delta.summary(to) },
    commandAck: s.commandAck.summary(),
    perClient: {
      msgsInPerSec: per(inT.total.msgs),
      bytesInPerSec: per(inT.total.bytes),
      msgsOutPerSec: per(outT.total.msgs),
      bytesOutPerSec: per(outT.total.bytes),
      bytesInByType,
    },
    errors: recorder.errorCounts(codec),
  };
}

export type ReportInput = {
  meta: Meta;
  recorder: RunRecorder;
  /** How many clients used each codec. */
  clientsByCodec: Partial<Record<CodecName, number>>;
  phases: Phases | null;
  resources: ResourceReport | null;
  first: readonly Sample[] | null;
  last: readonly Sample[] | null;
  lagCumulative: LagCumulative | null;
  /** Event-loop lag of the load generator itself, ms. */
  generatorLag?: { p99: number; max: number } | null;
};

/** Targets from the plan: getRows p95 under 50 ms, view change under 300 ms, delta p95 under 150 ms, event-loop lag p99 under 50 ms, RSS under 2 GB. */
export function evaluateTargets(codecs: readonly CodecReport[], server: ResourceReport | null, lag: LagCumulative | null): TargetResult[] {
  const per = (pick: (c: CodecReport) => number | undefined): Record<string, number | null> =>
    Object.fromEntries(codecs.map((c): [string, number | null] => [c.codec, pick(c) ?? null]));
  const verdict = (values: Record<string, number | null>, limit: number): boolean | null => {
    const present = Object.values(values).filter((v): v is number => v !== null);
    return present.length === 0 ? null : present.every((v) => v < limit);
  };
  const warm = per((c) => c.getRows.warm?.p95);
  const cold = per((c) => c.getRows.cold?.p95);
  const delta = per((c) => c.delta?.p95);
  const lagP99 = lag?.p99 ?? server?.eventLoopLagP99Ms?.max ?? null;
  const rss = server?.rssMb?.max ?? null;
  return [
    { name: 'getRows p95 (warm, client-measured)', target: '< 50 ms', unit: 'ms', values: warm, pass: verdict(warm, 50) },
    { name: 'View change: cold getRows p95', target: '< 300 ms', unit: 'ms', values: cold, pass: verdict(cold, 300) },
    { name: 'Delta latency p95 (serverTs to receipt)', target: '< 150 ms', unit: 'ms', values: delta, pass: verdict(delta, 150) },
    { name: 'Event-loop lag p99 (server, whole run)', target: '< 50 ms', unit: 'ms', values: { all: lagP99 }, pass: lagP99 === null ? null : lagP99 < 50 },
    { name: 'Server RSS max', target: '< 2048 MB', unit: 'MB', values: { all: rss }, pass: rss === null ? null : rss < 2048 },
  ];
}

export function buildReport(input: ReportInput): Report {
  const { recorder } = input;
  const durationS = input.meta.durationS;
  const codecs = (Object.entries(input.clientsByCodec) as [CodecName, number][])
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([codec, n]) => codecReport(recorder, codec, n, durationS, input.phases));
  return {
    meta: input.meta,
    phases: input.phases,
    codecs,
    server: input.resources,
    serverHistograms: input.first !== null && input.last !== null ? serverHistograms(input.first, input.last) : null,
    eventLoopLagCumulative: input.lagCumulative,
    generator: {
      sendLagMs: recorder.sendLags.summary(),
      eventLoopLagMs: input.generatorLag ?? null,
      note: 'Send lag is how late each request left the generator against its intended time; latencies are measured from the intended time, so it is already included in them.',
    },
    counters: { ...recorder.counters },
    commandRejects: Object.fromEntries(recorder.commandRejects),
    events: recorder.events,
    targets: evaluateTargets(codecs, input.resources, input.lagCumulative),
  };
}
