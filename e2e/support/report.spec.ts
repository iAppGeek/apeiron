import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { failuresOf, resultFileName, summariseLatency, writeReport, type ScenarioReport, type ViewReport } from './report';

const check = (name: string, ok: boolean): { name: string; ok: boolean; failures: string[]; stats: Record<string, number> } => ({
  name,
  ok,
  failures: ok ? [] : ['bad thing'],
  stats: {},
});

describe('summariseLatency', () => {
  it('takes medians and the worst p95, skipping empty samples', () => {
    const summary = summariseLatency([
      { p50: 10, p95: 40 },
      { p50: 20, p95: 80 },
      { p50: null, p95: null },
      { p50: 30, p95: 60 },
    ]);
    expect(summary).toEqual({ samples: 3, p50MedianMs: 20, p95MedianMs: 60, p95MaxMs: 80 });
  });

  it('returns nulls when nothing was sampled', () => {
    expect(summariseLatency([])).toEqual({ samples: 0, p50MedianMs: null, p95MedianMs: null, p95MaxMs: null });
  });
});

describe('failuresOf', () => {
  it('lists every failed check with its view', () => {
    const views: ViewReport[] = [
      { view: 'V1', reconnects: 1, deltasApplied: 1, rowsUpdated: 1, skipped: 0, purges: 0, lastCloseReason: null, closeHistory: [], toasts: [], latency: summariseLatency([]), checks: [check('server-vs-screen', false)] },
    ];
    expect(failuresOf(views, [check('model-vs-server', true), check('minimums', false)])).toEqual([
      'V1 server-vs-screen: bad thing',
      'minimums: bad thing',
    ]);
  });
});

describe('writeReport', () => {
  it('names files by scenario and ISO timestamp, and writes pretty JSON', () => {
    const at = new Date('2026-10-07T12:34:56.789Z');
    expect(resultFileName('S1', at)).toBe('S1-2026-10-07T12-34-56Z.json');
    const dir = mkdtempSync(join(tmpdir(), 'results-'));
    const report = { scenario: 'S1', startedAt: at.toISOString(), ok: true } as unknown as ScenarioReport;
    const path = writeReport(report, dir);
    expect(path).toBe(join(dir, 'S1-2026-10-07T12-34-56Z.json'));
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ scenario: 'S1', ok: true });
  });
});
