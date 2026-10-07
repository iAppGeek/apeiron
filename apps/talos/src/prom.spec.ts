import { describe, expect, it } from 'vitest';
import { histogramDelta, histogramQuantile, parseProm, sumOf, valueOf } from './prom.js';

const TEXT = `# HELP process_cpu_seconds_total Total user and system CPU time spent in seconds.
# TYPE process_cpu_seconds_total counter
process_cpu_seconds_total 12.5
nodejs_version_info{version="v24.1.0",major="24"} 1
apeiron_ws_messages_total{direction="out",type="delta",codec="json"} 40
apeiron_ws_messages_total{direction="out",type="rows",codec="json"} 2
weird{label="has \\"quotes\\", commas, and } braces"} 3
apeiron_getrows_duration_seconds_bucket{le="0.01",temp="warm",shape="flat"} 6
apeiron_getrows_duration_seconds_bucket{le="0.05",temp="warm",shape="flat"} 9
apeiron_getrows_duration_seconds_bucket{le="+Inf",temp="warm",shape="flat"} 10
apeiron_getrows_duration_seconds_bucket{le="0.01",temp="warm",shape="grouped"} 0
apeiron_getrows_duration_seconds_bucket{le="0.05",temp="warm",shape="grouped"} 1
apeiron_getrows_duration_seconds_bucket{le="+Inf",temp="warm",shape="grouped"} 2
apeiron_getrows_duration_seconds_count{temp="warm",shape="flat"} 10
apeiron_getrows_duration_seconds_count{temp="warm",shape="grouped"} 2
nan_metric NaN
some_gauge 1.5e3 1700000000000
garbage line here
`;

describe('parseProm', () => {
  const samples = parseProm(TEXT);

  it('reads names, labels and values, skipping comments and junk', () => {
    expect(valueOf(samples, 'process_cpu_seconds_total')).toBe(12.5);
    expect(valueOf(samples, 'nodejs_version_info', { major: '24' })).toBe(1);
    expect(valueOf(samples, 'some_gauge')).toBe(1500);
    expect(valueOf(samples, 'nan_metric')).toBeNaN();
    expect(valueOf(samples, 'missing')).toBeUndefined();
  });

  it('handles escaped quotes, commas and braces inside label values', () => {
    expect(samples.find((s) => s.name === 'weird')?.labels.label).toBe('has "quotes", commas, and } braces');
  });

  it('reads +Inf bucket bounds', () => {
    expect(samples.some((s) => s.labels.le === '+Inf')).toBe(true);
  });

  it('sums over matching label subsets', () => {
    expect(sumOf(samples, 'apeiron_ws_messages_total')).toBe(42);
    expect(sumOf(samples, 'apeiron_ws_messages_total', { type: 'delta' })).toBe(40);
    expect(sumOf(samples, 'apeiron_ws_messages_total', { codec: 'msgpack' })).toBe(0);
  });
});

describe('histograms', () => {
  const after = parseProm(TEXT);
  const before = parseProm(`apeiron_getrows_duration_seconds_bucket{le="0.01",temp="warm",shape="flat"} 1
apeiron_getrows_duration_seconds_bucket{le="0.05",temp="warm",shape="flat"} 2
apeiron_getrows_duration_seconds_bucket{le="+Inf",temp="warm",shape="flat"} 2
apeiron_getrows_duration_seconds_count{temp="warm",shape="flat"} 2`);

  it('merges shapes and subtracts the earlier scrape', () => {
    const d = histogramDelta(before, after, 'apeiron_getrows_duration_seconds', { temp: 'warm' });
    expect(d.buckets).toEqual([
      { le: 0.01, count: 5 },
      { le: 0.05, count: 8 },
      { le: Infinity, count: 10 },
    ]);
    expect(d.count).toBe(10);
  });

  it('interpolates quantiles inside the bucket like Prometheus', () => {
    const h = { buckets: [{ le: 0.01, count: 50 }, { le: 0.05, count: 100 }, { le: Infinity, count: 100 }], count: 100, sum: 0 };
    expect(histogramQuantile(h, 0.5)).toBeCloseTo(0.01, 9);
    expect(histogramQuantile(h, 0.75)).toBeCloseTo(0.03, 9);
    expect(histogramQuantile(h, 0.99)).toBeCloseTo(0.0492, 9);
  });

  it('returns the last finite bound when the quantile falls in the +Inf bucket, and NaN when empty', () => {
    const h = { buckets: [{ le: 0.1, count: 1 }, { le: Infinity, count: 10 }], count: 10, sum: 0 };
    expect(histogramQuantile(h, 0.99)).toBe(0.1);
    expect(histogramQuantile({ buckets: [], count: 0, sum: 0 }, 0.5)).toBeNaN();
  });

  it('treats a counter reset (a restarted server) as growth from zero', () => {
    const d = histogramDelta(after, before, 'apeiron_getrows_duration_seconds', { temp: 'warm' });
    expect(d.buckets.every((b) => b.count >= 0)).toBe(true);
  });
});
