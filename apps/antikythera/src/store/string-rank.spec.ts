import { mulberry32 } from '@apeiron/logos';
import { describe, expect, it } from 'vitest';
import { buildRankState, refreshRankState } from './string-rank.js';

const words = (n: number, seed: number, from = 0): string[] => {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => `w${Math.floor(rng() * 40).toString(36)}-${(from + i) % 7}`);
};

function drain<T>(gen: Generator<void, T>): T {
  let step = gen.next();
  while (step.done !== true) step = gen.next();
  return step.value;
}

describe('buildRankState', () => {
  it('ranks by position among distinct values, equal strings sharing a rank', () => {
    const state = buildRankState(['b', 'a', 'b', 'c'], 4);
    expect([...state.rank]).toEqual([1, 0, 1, 2]);
    expect(state.sorted).toEqual(['a', 'b', 'c']);
    expect(state.built).toBe(4);
    expect(state.dirty).toBe(false);
  });

  it('covers only the first n rows', () => {
    expect([...buildRankState(['z', 'a', 'm'], 2).rank]).toEqual([1, 0]);
  });
});

describe('refreshRankState', () => {
  it('equals a full rebuild after rows were appended, however small the slices', () => {
    const data = words(300, 1);
    const state = buildRankState(data, 300);
    data.push(...words(120, 2, 300));
    const refreshed = drain(refreshRankState(state, data, data.length, 7));
    expect(refreshed).not.toBeNull();
    const full = buildRankState(data, data.length);
    expect(refreshed?.sorted).toEqual(full.sorted);
    expect([...(refreshed?.rank ?? [])]).toEqual([...full.rank]);
    expect(refreshed?.built).toBe(data.length);
  });

  it('yields between slices so the loop can breathe', () => {
    const data = words(200, 3);
    const state = buildRankState(data, 100);
    let yields = 0;
    const run = refreshRankState(state, data, 200, 10);
    let step = run.next();
    while (step.done !== true) {
      yields++;
      step = run.next();
    }
    expect(yields).toBeGreaterThan(5);
  });

  it('returns null when the state went dirty mid-way', () => {
    const data = words(200, 4);
    const state = buildRankState(data, 100);
    const run = refreshRankState(state, data, 200, 10);
    run.next();
    state.dirty = true;
    let step = run.next();
    while (step.done !== true) step = run.next();
    expect(step.value).toBeNull();
  });

  it('is a no-op rebuild when nothing was appended', () => {
    const data = words(50, 5);
    const state = buildRankState(data, 50);
    const refreshed = drain(refreshRankState(state, data, 50, 10));
    expect([...(refreshed?.rank ?? [])]).toEqual([...state.rank]);
  });
});
