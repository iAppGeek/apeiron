import { describe, expect, it } from 'vitest';
import { BackpressureGate, DEFAULT_BACKPRESSURE } from './backpressure.js';

const opts = { softBytes: 100, hardBytes: 1_000, maxSlowMs: 5_000 };

describe('BackpressureGate', () => {
  it('sends while the buffer is below the soft cap', () => {
    const g = new BackpressureGate(opts);
    expect(g.decide(0, 0)).toBe('send');
    expect(g.decide(99, 10)).toBe('send');
    expect(g.slow).toBe(false);
  });

  it('holds above the soft cap and sends again once it drains', () => {
    const g = new BackpressureGate(opts);
    expect(g.decide(150, 0)).toBe('hold');
    expect(g.slow).toBe(true);
    expect(g.decide(500, 1_000)).toBe('hold');
    expect(g.decide(10, 2_000)).toBe('send');
    expect(g.slow).toBe(false);
  });

  it('closes above the hard cap immediately', () => {
    expect(new BackpressureGate(opts).decide(1_000, 0)).toBe('close');
  });

  it('closes after staying above the soft cap for too long, but a drain in between resets the clock', () => {
    const g = new BackpressureGate(opts);
    expect(g.decide(200, 0)).toBe('hold');
    expect(g.decide(200, 4_999)).toBe('hold');
    expect(g.decide(200, 5_000)).toBe('close');
    const h = new BackpressureGate(opts);
    expect(h.decide(200, 0)).toBe('hold');
    expect(h.decide(0, 4_000)).toBe('send');
    expect(h.decide(200, 6_000)).toBe('hold');
    expect(h.decide(200, 10_000)).toBe('hold');
  });

  it('has sensible defaults', () => {
    expect(DEFAULT_BACKPRESSURE.softBytes).toBeLessThan(DEFAULT_BACKPRESSURE.hardBytes);
  });
});
