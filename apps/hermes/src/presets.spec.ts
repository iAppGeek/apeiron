import { describe, expect, it } from 'vitest';
import { LOAD_PRESETS, TICKS_PER_SECOND } from './presets.js';

describe('LOAD_PRESETS', () => {
  it('matches the Appendix E rates', () => {
    expect(LOAD_PRESETS.medium).toMatchObject({ updatesPerSec: 100, newOrdersPerSec: 5, liveMin: 400, liveCap: 600 });
    expect(LOAD_PRESETS.stress).toMatchObject({ updatesPerSec: 2_000, newOrdersPerSec: 50, liveCap: 5_000 });
    expect(TICKS_PER_SECOND).toBe(3);
  });

  it('keeps each preset internally consistent', () => {
    for (const p of Object.values(LOAD_PRESETS)) {
      expect(p.liveMin).toBeLessThanOrEqual(p.liveTarget);
      expect(p.liveTarget).toBeLessThanOrEqual(p.liveCap);
    }
  });
});
