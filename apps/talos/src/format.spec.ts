import { describe, expect, it } from 'vitest';
import { consoleReport, markdownSummary, table } from './format.js';
import { RunRecorder } from './recorder.js';
import { buildReport } from './report.js';

const recorder = new RunRecorder(0);
for (let i = 1; i <= 20; i++) {
  recorder.rows({ codec: 'json', kind: 'warm', at: i * 100, ms: i, serverMs: 1 });
  recorder.delta({ codec: 'json', at: i * 100, ms: i, e2eMs: i + 100 });
}
recorder.rows({ codec: 'json', kind: 'cold', at: 100, ms: 90, serverMs: 80 });
recorder.event('slow.paused', 20_000, { x: 1 });
const report = buildReport({
  meta: { startedAt: '2026-10-07T00:00:00.000Z', durationS: 60, clients: 2, codec: 'json', url: 'ws://x', metricsUrl: 'http://x', seed: 3, options: {} },
  recorder,
  clientsByCodec: { json: 2 },
  phases: { stressFromS: 10, stressToS: 40 },
  resources: { cpuPercent: { min: 1, median: 5, max: 9, samples: 3 }, rssMb: { min: 800, median: 810, max: 820, samples: 3 }, heapUsedMb: null, eventLoopLagP99Ms: { min: 1, median: 2, max: 3, samples: 3 }, eventLoopLagMaxMs: null, scrapes: 3, failures: 0 },
  first: null,
  last: null,
  lagCumulative: { p50: 1, p99: 4, p999: 9, max: 30, samples: 10 },
});

describe('table', () => {
  it('left-aligns the first column and right-aligns the others to a common width', () => {
    expect(table([['', 'a', 'bb'], ['row', '1', '22']])).toBe('     a  bb\nrow  1  22');
  });
});

describe('consoleReport', () => {
  const text = consoleReport(report);

  it('has the latency table, phases, traffic, server ranges, targets and events', () => {
    expect(text).toContain('Latency, json (2 clients), ms');
    expect(text).toContain('getRows warm');
    expect(text).toContain('getRows cold (view change, after 10 s)');
    expect(text).toContain('Tick-to-screen by phase');
    expect(text).toContain('tick-to-screen (srcTs to receipt)');
    expect(text).toContain('last hop (serverTs to receipt)');
    expect(text).toContain('startup burst');
    expect(text).toContain('p99.9');
    expect(text).toContain('server at start');
    expect(text).toContain('Traffic per client, json');
    expect(text).toContain('RSS MB');
    expect(text).toContain('event-loop lag over the whole run');
    expect(text).toContain('Targets');
    expect(text).toContain('PASS');
    expect(text).toContain('slow.paused');
  });

  it('prints a dash for a series with no samples', () => {
    expect(text).toMatch(/command ack\s+-\s+-/);
  });
});

describe('markdownSummary', () => {
  it('is a pasteable table of targets and codec figures', () => {
    const md = markdownSummary(report);
    expect(md).toContain('### 2 clients, 60s, json');
    expect(md).toContain('| Target | Limit | Measured | Verdict |');
    expect(md).toContain('| json |');
    expect(md).toContain('Server: CPU median 5.0%');
    expect(md.endsWith('\n')).toBe(true);
  });
});
