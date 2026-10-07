import { describe, expect, it } from 'vitest';
import { createClockOffsetEstimator, createLatencyWindow, percentile, tickToScreenMs } from './latency';

describe('percentile', () => {
  it('uses the nearest rank', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(95);
    expect(percentile(sorted, 100)).toBe(100);
    expect(percentile(sorted, 0)).toBe(1);
  });

  it('is null for no samples and the sample itself for one', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([7], 95)).toBe(7);
  });
});

describe('createLatencyWindow', () => {
  it('reports p50 and p95 of the samples inside the window', () => {
    const w = createLatencyWindow(10_000);
    for (let i = 1; i <= 20; i += 1) w.record(1000 + i, i);
    expect(w.snapshot(1100)).toEqual({ p50: 10, p95: 19, count: 20 });
  });

  it('drops samples older than the window', () => {
    const w = createLatencyWindow(10_000);
    w.record(0, 500);
    w.record(5000, 10);
    w.record(9000, 20);
    expect(w.snapshot(9999)).toMatchObject({ count: 3, p95: 500 });
    expect(w.snapshot(10_000)).toMatchObject({ count: 2, p95: 20 });
    expect(w.snapshot(20_000)).toEqual({ p50: null, p95: null, count: 0 });
  });

  it('reset clears the window', () => {
    const w = createLatencyWindow(10_000);
    w.record(1, 5);
    w.reset();
    expect(w.snapshot(2).count).toBe(0);
  });
});

describe('createClockOffsetEstimator', () => {
  it('is null before a sample', () => {
    expect(createClockOffsetEstimator().offsetMs()).toBeNull();
  });

  it('assumes the server stamped the pong halfway through the round trip', () => {
    const e = createClockOffsetEstimator();
    // Sent at 1000, back at 1020: the midpoint is 1010; the server said 1510, so it is 500ms ahead.
    e.addSample(1000, 1510, 1020);
    expect(e.offsetMs()).toBe(500);
  });

  it('supports a server clock behind the client', () => {
    const e = createClockOffsetEstimator();
    e.addSample(1000, 710, 1020);
    expect(e.offsetMs()).toBe(-300);
  });

  it('trusts the sample with the smallest round trip', () => {
    const e = createClockOffsetEstimator();
    e.addSample(1000, 1300, 1200); // rtt 200, offset 200
    e.addSample(2000, 2250, 2004); // rtt 4, offset 248
    e.addSample(3000, 3400, 3100); // rtt 100, offset 350
    expect(e.offsetMs()).toBe(248);
  });

  it('forgets samples beyond the last N, and on reset', () => {
    const e = createClockOffsetEstimator(2);
    e.addSample(0, 100, 2); // best rtt, offset 99, falls out of the window
    e.addSample(10, 300, 40); // rtt 30, offset 275
    e.addSample(50, 400, 60); // rtt 10, offset 345
    expect(e.offsetMs()).toBe(345);
    e.reset();
    expect(e.offsetMs()).toBeNull();
  });
});

describe('tickToScreenMs', () => {
  it('is applied time on the server clock minus the server timestamp', () => {
    expect(tickToScreenMs(10_050, 10_000, 0)).toBe(50);
  });

  it('corrects for the clock offset', () => {
    // Server clock is 5s ahead: the tick was stamped 15_000 server time, applied at 10_040 client = 15_040 server.
    expect(tickToScreenMs(10_040, 15_000, 5000)).toBe(40);
  });

  it('treats an unknown offset as zero and never goes negative', () => {
    expect(tickToScreenMs(100, 90, null)).toBe(10);
    expect(tickToScreenMs(100, 130, null)).toBe(0);
  });
});
