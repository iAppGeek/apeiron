import { describe, expect, it } from 'vitest';
import { mulberry32, normal, pick, pickWeighted, pickWeightedIndex, randInt, uniform } from './prng.js';

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 1000; i++) expect(a()).toBe(b());
  });

  it('produces known reference values for seed 42', () => {
    const rng = mulberry32(42);
    expect([rng(), rng(), rng()]).toEqual([0.6011037519201636, 0.44829055899754167, 0.8524657934904099]);
  });

  it('differs between seeds', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });

  it('stays in [0, 1) with a roughly uniform mean', () => {
    const rng = mulberry32(7);
    let sum = 0;
    const n = 100_000;
    for (let i = 0; i < n; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      sum += v;
    }
    expect(sum / n).toBeGreaterThan(0.49);
    expect(sum / n).toBeLessThan(0.51);
  });
});

describe('sampling helpers', () => {
  it('uniform stays inside its bounds', () => {
    const rng = mulberry32(3);
    for (let i = 0; i < 1000; i++) {
      const v = uniform(rng, 5, 10);
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThan(10);
    }
  });

  it('randInt is inclusive on both ends', () => {
    const rng = mulberry32(3);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) seen.add(randInt(rng, 1, 3));
    expect([...seen].sort()).toEqual([1, 2, 3]);
  });

  it('normal has the requested mean and standard deviation', () => {
    const rng = mulberry32(11);
    const n = 100_000;
    const xs = Array.from({ length: n }, () => normal(rng, 0.5, 2));
    const mean = xs.reduce((a, b) => a + b, 0) / n;
    const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    expect(mean).toBeCloseTo(0.5, 1);
    expect(Math.sqrt(variance)).toBeCloseTo(2, 1);
  });

  it('pickWeightedIndex respects weights', () => {
    const rng = mulberry32(5);
    const counts = [0, 0, 0];
    for (let i = 0; i < 100_000; i++) counts[pickWeightedIndex(rng, [1, 2, 7])]!++;
    expect(counts[2]! / 100_000).toBeCloseTo(0.7, 1);
    expect(counts[0]! / 100_000).toBeCloseTo(0.1, 1);
  });

  it('pickWeighted and pick return members and throw on empty input', () => {
    const rng = mulberry32(5);
    expect(['a', 'b']).toContain(pickWeighted(rng, ['a', 'b'], [1, 1]));
    expect(['a', 'b']).toContain(pick(rng, ['a', 'b']));
    expect(() => pick(rng, [])).toThrow();
    expect(() => pickWeighted(rng, [], [])).toThrow();
  });
});
