import { mulberry32, parseClientMsg } from '@apeiron/logos';
import { describe, expect, it } from 'vitest';
import { QueryEngine } from '../query/engine.js';
import { propertyOrders, storeFrom } from './dataset.js';
import { randomRequest } from './request-gen.js';

describe('randomRequest', () => {
  const orders = propertyOrders(9, 800);
  const engine = new QueryEngine(storeFrom(orders), { maxViews: 4, maxBytes: 1 << 20, maxBlockRows: 5_000 });

  it('always produces requests the protocol schema and the engine accept', () => {
    const rng = mulberry32(77);
    const kinds = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const { traderId, req } = randomRequest(rng, orders);
      expect(parseClientMsg({ t: 'getRows', reqId: i, req }).ok).toBe(true);
      const r = engine.getRows(traderId, req);
      expect(r.ok, JSON.stringify(req)).toBe(true);
      for (const f of Object.values(req.filterModel ?? {})) kinds.add((f as { filterType: string }).filterType);
    }
    expect([...kinds].sort()).toEqual(['date', 'number', 'set', 'text']);
  });

  it('is deterministic for a seed', () => {
    expect(randomRequest(mulberry32(1), orders)).toEqual(randomRequest(mulberry32(1), orders));
  });
});
