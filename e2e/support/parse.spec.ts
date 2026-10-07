import { describe, expect, it } from 'vitest';
import { isMonotonic, isTextSorted, parseGroupCount, parseLeadingCount, parseNumber } from './parse';

describe('parseNumber', () => {
  it('reads thousands separators and decimals', () => {
    expect(parseNumber('1,234,567.89')).toBe(1234567.89);
    expect(parseNumber('-12.5')).toBe(-12.5);
    expect(parseNumber(' 42 ')).toBe(42);
  });

  it('returns NaN for blanks and non-numbers', () => {
    expect(parseNumber('')).toBeNaN();
    expect(parseNumber('—')).toBeNaN();
    expect(parseNumber('12abc')).toBeNaN();
  });
});

describe('parseLeadingCount', () => {
  it('reads the badge count', () => {
    expect(parseLeadingCount('27 new orders ↑')).toBe(27);
    expect(parseLeadingCount('1,204 new orders')).toBe(1204);
    expect(parseLeadingCount('no digits')).toBe(0);
  });
});

describe('parseGroupCount', () => {
  it('reads the count after a group key', () => {
    expect(parseGroupCount('EURUSD (123,456)')).toBe(123456);
    expect(parseGroupCount('EURUSD')).toBeNull();
  });
});

describe('isMonotonic', () => {
  it('accepts ties and ignores NaN', () => {
    expect(isMonotonic([1, 2, 2, Number.NaN, 5], 'asc')).toBe(true);
    expect(isMonotonic([5, 4, 4, 1], 'desc')).toBe(true);
  });

  it('rejects the wrong direction', () => {
    expect(isMonotonic([1, 3, 2], 'asc')).toBe(false);
    expect(isMonotonic([1, 3], 'desc')).toBe(false);
  });

  it('accepts an empty list', () => {
    expect(isMonotonic([], 'asc')).toBe(true);
  });
});

describe('isTextSorted', () => {
  it('compares case-insensitively', () => {
    expect(isTextSorted(['alice', 'Ben', 'chloe'], 'asc')).toBe(true);
    expect(isTextSorted(['chloe', 'Ben', 'alice'], 'desc')).toBe(true);
    expect(isTextSorted(['b', 'a'], 'asc')).toBe(false);
  });
});
