import { describe, expect, it } from 'vitest';
import { LagMonitor, withLagReport } from './lag.js';

const spin = (ms: number): void => {
  const t = performance.now();
  while (performance.now() - t < ms);
};

describe('LagMonitor', () => {
  it('reads near zero when idle', async () => {
    const m = new LagMonitor(10);
    m.start();
    const { lag } = await withLagReport(m, () => new Promise<void>((r) => setTimeout(r, 120)));
    m.stop();
    expect(lag.samples).toBeGreaterThan(3);
    expect(lag.p99).toBeLessThan(100);
  });

  it('records a synchronous stall', async () => {
    const m = new LagMonitor(10);
    m.start();
    const { lag, result } = await withLagReport(m, () => {
      spin(150);
      return 'done';
    });
    m.stop();
    expect(result).toBe('done');
    expect(lag.max).toBeGreaterThan(100);
    expect(lag.p999).toBeGreaterThanOrEqual(lag.p99);
    expect(lag.max).toBeGreaterThanOrEqual(lag.p999);
  });
});
