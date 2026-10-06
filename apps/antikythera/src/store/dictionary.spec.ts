import { describe, expect, it } from 'vitest';
import { Dictionary, MAX_DICTIONARY_SIZE } from './dictionary.js';

describe('Dictionary', () => {
  it('assigns codes in first-seen order and reuses them', () => {
    const d = new Dictionary();
    expect(d.getOrAdd('b')).toBe(0);
    expect(d.getOrAdd('a')).toBe(1);
    expect(d.getOrAdd('b')).toBe(0);
    expect(d.size).toBe(2);
    expect(d.codeOf('a')).toBe(1);
    expect(d.codeOf('zzz')).toBeUndefined();
  });

  it('ranks codes by value order and refreshes after additions', () => {
    const d = new Dictionary();
    d.getOrAdd('m');
    d.getOrAdd('c');
    expect([...d.rank]).toEqual([1, 0]);
    d.getOrAdd('a');
    expect([...d.rank]).toEqual([2, 1, 0]);
    expect(d.sortedValues()).toEqual(['a', 'c', 'm']);
  });

  it('orders by code unit, so uppercase sorts before lowercase', () => {
    const d = new Dictionary();
    d.getOrAdd('b');
    d.getOrAdd('B');
    expect(d.sortedValues()).toEqual(['B', 'b']);
  });

  it('throws on overflow', () => {
    const d = new Dictionary();
    for (let i = 0; i < MAX_DICTIONARY_SIZE; i++) d.getOrAdd(String(i));
    expect(() => d.getOrAdd('one-too-many')).toThrow(/overflow/);
  });
});
