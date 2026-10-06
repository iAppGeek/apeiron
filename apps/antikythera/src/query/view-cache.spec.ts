import { describe, expect, it } from 'vitest';
import { makeStore } from '../testing/orders.js';
import { ViewCache } from './view-cache.js';
import { View } from './view.js';

const store = makeStore([{ orderQty: 1 }]);
const mk = (bytes: number): View => {
  const v = new View(store, { sort: [], groupCols: [], valueCols: [] }, new Uint32Array(1), true);
  v.bytes = bytes;
  return v;
};

describe('ViewCache', () => {
  it('returns what was stored and counts hits and misses', () => {
    const cache = new ViewCache({ maxViews: 4, maxBytes: 1_000 });
    const v = mk(10);
    cache.set('a', v);
    expect(cache.get('a')).toBe(v);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.stats()).toMatchObject({ views: 1, bytes: 10, hits: 1, misses: 1, evictions: 0 });
    expect(cache.has('a')).toBe(true);
  });

  it('evicts the least recently used view when over the view cap', () => {
    const cache = new ViewCache({ maxViews: 2, maxBytes: 1_000 });
    cache.set('a', mk(1));
    cache.set('b', mk(1));
    cache.get('a');
    cache.set('c', mk(1));
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
    expect(cache.stats().evictions).toBe(1);
  });

  it('evicts by total index memory', () => {
    const cache = new ViewCache({ maxViews: 10, maxBytes: 100 });
    cache.set('a', mk(60));
    cache.set('b', mk(30));
    cache.set('c', mk(30));
    expect(cache.has('a')).toBe(false);
    expect(cache.stats().bytes).toBe(60);
  });

  it('rebalances after a view grows, never evicting the one in use', () => {
    const cache = new ViewCache({ maxViews: 10, maxBytes: 100 });
    const a = mk(10);
    const b = mk(10);
    cache.set('a', a);
    cache.set('b', b);
    b.bytes = 500;
    cache.rebalance('b');
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
  });

  it('keeps a single oversized view', () => {
    const cache = new ViewCache({ maxViews: 1, maxBytes: 10 });
    cache.set('big', mk(1_000));
    expect(cache.has('big')).toBe(true);
  });

  it('clears everything', () => {
    const cache = new ViewCache({ maxViews: 2, maxBytes: 100 });
    cache.set('a', mk(1));
    cache.clear();
    expect(cache.stats().views).toBe(0);
  });
});
