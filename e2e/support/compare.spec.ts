import { describe, expect, it } from 'vitest';
import { contiguousRuns, describeDiffs, diffRecords } from './compare';

describe('diffRecords', () => {
  it('finds differing fields over the keys of the actual row', () => {
    expect(diffRecords({ a: 1, b: 2, c: 3 }, { a: 1, b: 9, d: 4 })).toEqual([{ field: 'b', expected: 9, actual: 2 }]);
  });

  it('treats undefined and null alike, and leaves out excluded fields', () => {
    expect(diffRecords({ a: null, b: 1, t: 5 }, { a: undefined, b: 1, t: 6 }, { excluded: new Set(['t']) })).toEqual([]);
  });

  it('applies a relative tolerance only when asked', () => {
    expect(diffRecords({ sum: 1_000_000.0000001 }, { sum: 1_000_000 })).toHaveLength(1);
    expect(diffRecords({ sum: 1_000_000.0000001 }, { sum: 1_000_000 }, { tolerance: 1e-9 })).toEqual([]);
    expect(diffRecords({ sum: 1.1 }, { sum: 1 }, { tolerance: 1e-9 })).toHaveLength(1);
  });

  it('reports a key the actual row lacks only in strict mode', () => {
    expect(diffRecords({ a: 1 }, { a: 1, b: 2 })).toEqual([]);
    expect(diffRecords({ a: 1 }, { a: 1, b: 2 }, {}, true)).toEqual([{ field: 'b', expected: 2, actual: null }]);
  });
});

describe('contiguousRuns', () => {
  it('groups consecutive indexes', () => {
    expect(contiguousRuns([3, 4, 5, 9, 10, 20])).toEqual([
      { start: 3, end: 6 },
      { start: 9, end: 11 },
      { start: 20, end: 21 },
    ]);
    expect(contiguousRuns([])).toEqual([]);
  });

  it('ignores a repeated index', () => {
    expect(contiguousRuns([1, 1, 2])).toEqual([{ start: 1, end: 3 }]);
  });
});

describe('describeDiffs', () => {
  it('summarises and truncates', () => {
    const diffs = Array.from({ length: 6 }, (_, i) => ({ field: `f${i}`, expected: i, actual: i + 1 }));
    const text = describeDiffs('ALG1', diffs);
    expect(text).toContain('ALG1: f0: expected 0 got 1');
    expect(text).toContain('(+2 more)');
  });
});
