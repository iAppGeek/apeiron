import { mulberry32 } from '@apeiron/logos';
import { describe, expect, it } from 'vitest';
import { RowBuf } from './row-buf.js';

const buf = (...values: number[]): RowBuf => new RowBuf(Uint32Array.from(values));

describe('RowBuf', () => {
  it('exposes its live contents and size', () => {
    const b = buf(1, 4, 9);
    expect([...b.view]).toEqual([1, 4, 9]);
    expect(b.len).toBe(3);
    expect(b.at(1)).toBe(4);
    expect(b.bytes).toBe(12);
    expect(RowBuf.empty().len).toBe(0);
  });

  it('finds positions in an ascending array', () => {
    const b = buf(2, 4, 6, 8);
    expect(b.lowerBound(1)).toBe(0);
    expect(b.lowerBound(4)).toBe(1);
    expect(b.lowerBound(5)).toBe(2);
    expect(b.lowerBound(99)).toBe(4);
    expect(b.contains(6)).toBe(true);
    expect(b.contains(7)).toBe(false);
    expect(RowBuf.empty().contains(0)).toBe(false);
  });

  it('removes elements at ascending positions, including the ends and adjacent ones', () => {
    const b = buf(10, 11, 12, 13, 14, 15, 16);
    b.removeAt([0, 2, 3, 6]);
    expect([...b.view]).toEqual([11, 14, 15]);
    b.removeAt([]);
    expect([...b.view]).toEqual([11, 14, 15]);
    b.removeAt([0, 1, 2]);
    expect(b.len).toBe(0);
  });

  it('inserts before original positions, keeping item order for equal positions, and grows', () => {
    const b = buf(10, 20, 30);
    b.insertAt([5, 15, 16, 25, 99], [0, 1, 1, 2, 3]);
    expect([...b.view]).toEqual([5, 10, 15, 16, 20, 25, 30, 99]);
    expect(b.buf.length).toBeGreaterThanOrEqual(8);
    const e = RowBuf.empty();
    e.insertAt([3, 4], [0, 0]);
    expect([...e.view]).toEqual([3, 4]);
  });

  it('appends a range of ascending values', () => {
    const b = RowBuf.empty();
    b.appendRange(0, 5);
    b.appendRange(5, 5);
    b.appendRange(5, 8);
    expect([...b.view]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('matches a plain array model under random removals and insertions', () => {
    const rng = mulberry32(5);
    const model: number[] = Array.from({ length: 200 }, (_, i) => i * 3);
    const b = new RowBuf(Uint32Array.from(model));
    for (let round = 0; round < 200; round++) {
      const removals = [...new Set(Array.from({ length: Math.floor(rng() * 8) }, () => model[Math.floor(rng() * model.length)] as number))].sort((x, y) => x - y);
      b.removeAt(removals.map((v) => b.lowerBound(v)));
      for (const v of removals) model.splice(model.indexOf(v), 1);
      const inserts = [...new Set(Array.from({ length: Math.floor(rng() * 8) }, () => Math.floor(rng() * 900)))].filter((v) => !model.includes(v)).sort((x, y) => x - y);
      b.insertAt(inserts, inserts.map((v) => b.lowerBound(v)));
      model.push(...inserts);
      model.sort((x, y) => x - y);
      expect([...b.view]).toEqual(model);
    }
  });
});
