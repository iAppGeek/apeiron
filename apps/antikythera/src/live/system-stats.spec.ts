import { describe, expect, it } from 'vitest';
import { SystemStats } from './system-stats.js';

const busyFor = (ms: number): void => {
  const end = performance.now() + ms;
  while (performance.now() < end) Math.sqrt(Math.random());
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('SystemStats', () => {
  it('reports CPU busy share, RSS and window lag, and starts a new window each sample', async () => {
    const s = new SystemStats();
    s.start();
    try {
      await sleep(30);
      s.sample();
      busyFor(150);
      await sleep(30);
      const sample = s.sample();
      expect(sample.cpu).toBeGreaterThan(30);
      expect(sample.rssMb).toBeGreaterThan(10);
      expect(sample.elLagMs).toBeGreaterThanOrEqual(0);
      expect(s.latest).toBe(sample);
      await sleep(40);
      expect(s.sample().cpu).toBeLessThan(sample.cpu);
    } finally {
      s.stop();
    }
  });

  it('keeps a cumulative lag histogram that can be reset', async () => {
    const s = new SystemStats();
    s.start();
    try {
      await sleep(40);
      busyFor(120);
      await sleep(40);
      const blockedMax = s.totalLag().max;
      expect(blockedMax).toBeGreaterThan(50);
      s.resetTotalLag();
      await sleep(40);
      // Relative, not absolute: a loaded machine (CI, the compose stack) adds its own lag after the reset.
      expect(s.totalLag().max).toBeLessThan(blockedMax);
    } finally {
      s.stop();
    }
  });
});
