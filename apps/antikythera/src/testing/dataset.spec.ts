import { describe, expect, it } from 'vitest';
import { FIXED_NOW, generateStore, propertyOrders, storeFrom } from './dataset.js';

describe('test datasets', () => {
  it('generates a store of real generator data', () => {
    const store = generateStore(2_500, 42, 3_000);
    expect(store.size).toBe(2_500);
    expect(store.rowAt(0).orderId).toBe('ALG00000001');
    expect(store.idsAscending).toBe(true);
    expect(FIXED_NOW).toBe(Date.UTC(2026, 9, 6, 12));
  });

  it('is deterministic and injects nulls, statuses and null value dates', () => {
    const a = propertyOrders(5, 2_000);
    expect(propertyOrders(5, 2_000)).toEqual(a);
    expect(a.some((o) => o.limitPrice === null)).toBe(true);
    expect(a.some((o) => o.status === 'LIVE' || o.status === 'PAUSED')).toBe(true);
    expect(a.some((o) => (o.valueDate as number | null) === null)).toBe(true);
    expect(storeFrom(a).size).toBe(2_000);
  });
});
