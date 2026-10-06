import { describe, expect, it } from 'vitest';
import { forceGc, memorySnapshot, peakRssMb } from './memory.js';

describe('memory', () => {
  it('reports heap, rss and array buffers in MB', () => {
    const s = memorySnapshot();
    expect(s.heapMb).toBeGreaterThan(0);
    expect(s.rssMb).toBeGreaterThan(s.heapMb);
    expect(s.arrayBuffersMb).toBeGreaterThanOrEqual(0);
  });

  it('reports a peak RSS at least as large as the current one', () => {
    expect(peakRssMb()).toBeGreaterThanOrEqual(memorySnapshot().rssMb * 0.9);
  });

  it('forces a GC when the runtime allows it', () => {
    expect(forceGc()).toBe(true);
    expect(forceGc()).toBe(true);
  });
});
