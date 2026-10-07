import type { Summary } from './stats.js';
import type { CodecReport, Report } from './report.js';

const n = (v: number | null | undefined, digits = 1): string => (v === null || v === undefined || Number.isNaN(v) ? '-' : v.toFixed(digits));
const q = (s: Summary | null, pick: (s: Summary) => number): string => (s === null ? '-' : n(pick(s)));
const kb = (bytes: number): string => n(bytes / 1024, 1);

/** Left-aligns the first column and right-aligns the rest. */
export function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length))) ?? [];
  return rows.map((r) => r.map((cell, i) => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0))).join('  ')).join('\n');
}

function latencyRows(c: CodecReport): string[][] {
  return [
    ['getRows warm', q(c.getRows.warm, (s) => s.p50), q(c.getRows.warm, (s) => s.p95), q(c.getRows.warm, (s) => s.p99), q(c.getRows.warm, (s) => s.max), String(c.getRows.warm?.count ?? 0)],
    ['getRows cold (view change, after 10 s)', q(c.getRows.cold, (s) => s.p50), q(c.getRows.cold, (s) => s.p95), q(c.getRows.cold, (s) => s.p99), q(c.getRows.cold, (s) => s.max), String(c.getRows.cold?.count ?? 0)],
    ['tick-to-screen (srcTs to receipt)', q(c.tickToScreen, (s) => s.p50), q(c.tickToScreen, (s) => s.p95), q(c.tickToScreen, (s) => s.p99), q(c.tickToScreen, (s) => s.max), String(c.tickToScreen?.count ?? 0)],
    ['  last hop (serverTs to receipt)', q(c.delta, (s) => s.p50), q(c.delta, (s) => s.p95), q(c.delta, (s) => s.p99), q(c.delta, (s) => s.max), String(c.delta?.count ?? 0)],
    ['getRows startup burst (first view, all at once)', q(c.getRows.startup, (s) => s.p50), q(c.getRows.startup, (s) => s.p95), q(c.getRows.startup, (s) => s.p99), q(c.getRows.startup, (s) => s.max), String(c.getRows.startup?.count ?? 0)],
    ['command ack', q(c.commandAck, (s) => s.p50), q(c.commandAck, (s) => s.p95), q(c.commandAck, (s) => s.p99), q(c.commandAck, (s) => s.max), String(c.commandAck?.count ?? 0)],
  ];
}

/** The console report: one latency table per codec, traffic, server resources, targets and special-client events. */
export function consoleReport(r: Report): string {
  const out: string[] = [];
  out.push(`talos: ${r.meta.clients} clients, ${r.meta.durationS}s, codec ${r.meta.codec}, seed ${r.meta.seed}, ${r.meta.startedAt}`);
  out.push(`server at start: ${n(r.start.storeRows, 0)} rows, ${n(r.start.liveRows, 0)} LIVE`);
  for (const c of r.codecs) {
    out.push('', `Latency, ${c.codec} (${c.clients} clients), ms`);
    out.push(table([['', 'p50', 'p95', 'p99', 'max', 'n'], ...latencyRows(c)]));
    if (c.tickToScreenByPhase !== null) {
      const d = c.tickToScreenByPhase;
      out.push('', `Tick-to-screen by phase, ${c.codec}, ms`);
      out.push(table([['', 'p50', 'p95', 'p99', 'max', 'n'], ...(['baseline', 'stress', 'after'] as const).map((k) => [k, q(d[k], (s) => s.p50), q(d[k], (s) => s.p95), q(d[k], (s) => s.p99), q(d[k], (s) => s.max), String(d[k]?.count ?? 0)])]));
    }
    out.push('', `Traffic per client, ${c.codec}`);
    out.push(table([['', 'msgs/s', 'KB/s'], ['in', n(c.perClient.msgsInPerSec), kb(c.perClient.bytesInPerSec)], ['out', n(c.perClient.msgsOutPerSec), kb(c.perClient.bytesOutPerSec)]]));
    out.push(`errors by code: ${Object.keys(c.errors).length === 0 ? 'none' : JSON.stringify(c.errors)}`);
  }
  if (r.server !== null) {
    const s = r.server;
    const row = (name: string, v: typeof s.rssMb, digits = 1): string[] => [name, n(v?.min, digits), n(v?.median, digits), n(v?.max, digits)];
    out.push('', `Server (/metrics every 2s, ${s.scrapes} scrapes, ${s.failures} failed)`);
    out.push(table([['', 'min', 'median', 'max'], row('CPU % of one core', s.cpuPercent), row('RSS MB', s.rssMb, 0), row('heap used MB', s.heapUsedMb, 0), row('event-loop lag p99 ms (1s windows)', s.eventLoopLagP99Ms), row('event-loop lag max ms (1s windows)', s.eventLoopLagMaxMs)]));
  }
  if (r.eventLoopLagCumulative !== null) {
    const l = r.eventLoopLagCumulative;
    out.push(`event-loop lag over the whole run (server histogram): p50 ${n(l.p50)} ms, p99 ${n(l.p99)} ms, p99.9 ${n(l.p999)} ms, longest stall ${n(l.max)} ms`);
  }
  const h = r.serverHistograms;
  if (h !== null) {
    out.push('', 'Server-side histograms over the run');
    out.push(table([
      ['', 'value'],
      ['getRows warm p95 ms', n(h.getRowsWarmP95Ms, 2)],
      ['getRows cold p95 ms', n(h.getRowsColdP95Ms, 2)],
      ['getRows cold / warm count', `${h.getRowsColdCount} / ${h.getRowsWarmCount}`],
      ['flush p50 / p99 ms', `${n(h.flushP50Ms, 2)} / ${n(h.flushP99Ms, 2)}`],
      ['event age at flush p95 ms', n(h.eventAgeP95Ms, 1)],
      ['event age at send p95 ms (server side of tick-to-screen)', n(h.eventAgeAtSendP95Ms, 1)],
      ['delta size p95 bytes', n(h.deltaBytesP95, 0)],
      ['command p95 ms', n(h.commandP95Ms, 1)],
      ['soft_conflate / slow_consumer events', `${h.softConflates} / ${h.slowConsumers}`],
    ]));
  }
  out.push('', 'Targets');
  out.push(table([['', 'target', 'measured', 'verdict'], ...r.targets.map((t) => [t.name, t.target, Object.entries(t.values).map(([k, v]) => `${k} ${n(v)}`).join(', '), t.pass === null ? 'n/a' : t.pass ? 'PASS' : 'FAIL'])]));
  if (r.events.length > 0) {
    out.push('', 'Events (seconds into the run)');
    for (const e of r.events) out.push(`  ${n(e.t / 1000, 1).padStart(7)}s  ${e.name} ${Object.keys(e.detail).length === 0 ? '' : JSON.stringify(e.detail)}`);
  }
  out.push('', `generator: send lag p99 ${q(r.generator.sendLagMs, (s) => s.p99)} ms, max ${q(r.generator.sendLagMs, (s) => s.max)} ms; own event-loop lag p99 ${n(r.generator.eventLoopLagMs?.p99)} ms, max ${n(r.generator.eventLoopLagMs?.max)} ms; counters ${JSON.stringify(r.counters)}`);
  return out.join('\n');
}

/** A short Markdown summary to paste into docs. */
export function markdownSummary(r: Report): string {
  const lines: string[] = [];
  lines.push(`### ${r.meta.clients} clients, ${r.meta.durationS}s, ${r.meta.codec}`, '', `Server at start: ${n(r.start.storeRows, 0)} rows, ${n(r.start.liveRows, 0)} LIVE.`, '');
  lines.push('| Target | Limit | Measured | Verdict |', '|---|---|---|---|');
  for (const t of r.targets) {
    const measured = Object.entries(t.values).map(([k, v]) => (k === 'all' ? `${n(v)} ${t.unit}` : `${k} ${n(v)} ${t.unit}`)).join(', ');
    lines.push(`| ${t.name} | ${t.target} | ${measured} | ${t.pass === null ? 'n/a' : t.pass ? 'PASS' : 'FAIL'} |`);
  }
  lines.push('', '| Codec | getRows warm p50/p95/p99 ms | getRows cold p50/p95/p99 ms | tick-to-screen p50/p95/p99 ms | last hop p50/p95/p99 ms | startup burst p50/p95/max ms | command ack p50/p95 ms | msgs/s/client in | KB/s/client in |', '|---|---|---|---|---|---|---|---|---|');
  for (const c of r.codecs) {
    const trio = (s: Summary | null): string => (s === null ? '-' : `${n(s.p50)} / ${n(s.p95)} / ${n(s.p99)}`);
    lines.push(`| ${c.codec} | ${trio(c.getRows.warm)} | ${trio(c.getRows.cold)} | ${trio(c.tickToScreen)} | ${trio(c.delta)} | ${c.getRows.startup === null ? '-' : `${n(c.getRows.startup.p50)} / ${n(c.getRows.startup.p95)} / ${n(c.getRows.startup.max)}`} | ${c.commandAck === null ? '-' : `${n(c.commandAck.p50)} / ${n(c.commandAck.p95)}`} | ${n(c.perClient.msgsInPerSec)} | ${kb(c.perClient.bytesInPerSec)} |`);
  }
  if (r.server !== null) {
    const s = r.server;
    lines.push('', `Server: CPU median ${n(s.cpuPercent?.median)}% (max ${n(s.cpuPercent?.max)}%), RSS median ${n(s.rssMb?.median, 0)} MB (max ${n(s.rssMb?.max, 0)} MB), heap max ${n(s.heapUsedMb?.max, 0)} MB, event-loop lag p99 (1s windows) median ${n(s.eventLoopLagP99Ms?.median)} ms, max ${n(s.eventLoopLagP99Ms?.max)} ms.`);
  }
  return `${lines.join('\n')}\n`;
}
