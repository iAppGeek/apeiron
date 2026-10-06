import { PAIRS, PAIR_BY_NAME, finalMids, mulberry32, type CurrencyPair } from '@apeiron/logos';
import { describe, expect, it } from 'vitest';
import { PriceFeed, startingMids } from './price-feed.js';
import { SEED_NOW, currentOrders } from './testing.js';

function feed(seed = 1, start = startingMids([])): PriceFeed {
  return new PriceFeed(mulberry32(seed), start);
}

describe('startingMids', () => {
  it('falls back to the reference mid for pairs without current orders', () => {
    const mids = startingMids([]);
    for (const p of PAIRS) expect(mids[p.pair]).toBe(p.mid);
  });

  it('uses the marketMid of the most recently updated order per pair', () => {
    const orders = currentOrders();
    const eur = orders.filter((o) => o.currencyPair === 'EURUSD');
    expect(eur.length).toBeGreaterThan(1);
    const newest = eur[0];
    if (newest === undefined) throw new Error('no EURUSD order');
    newest.lastUpdateTime += 10_000_000;
    newest.marketMid = 1.00123;
    expect(startingMids(orders).EURUSD).toBe(1.00123);
  });

  it('breaks lastUpdateTime ties by the higher orderId', () => {
    const [a, b] = currentOrders().filter((o) => o.currencyPair === 'EURUSD');
    if (a === undefined || b === undefined) throw new Error('need two orders');
    a.lastUpdateTime = b.lastUpdateTime = 5;
    a.orderId = 'ALG00000001';
    b.orderId = 'ALG00000002';
    a.marketMid = 1.1;
    b.marketMid = 1.2;
    expect(startingMids([b, a]).EURUSD).toBe(1.2);
  });

  it('starts from the generator final mids, not the reference levels', () => {
    const final = finalMids(42, 100_000, SEED_NOW);
    const mids = startingMids(currentOrders());
    for (const p of PAIRS) {
      const dec = PAIR_BY_NAME.get(p.pair)?.decimals ?? 5;
      const live = currentOrders().some((o) => o.currencyPair === p.pair);
      if (live) expect(mids[p.pair]).toBeCloseTo(final[p.pair], dec - 1);
    }
    expect(Math.abs(mids.EURUSD - 1.08)).toBeGreaterThan(0);
  }, 30_000);
});

describe('PriceFeed', () => {
  it('emits one tick per pair with bid below ask, rounded to the pair decimals', () => {
    const f = feed();
    const ticks = f.tick(1_000);
    expect(ticks.map((t) => t.pair)).toEqual(PAIRS.map((p) => p.pair));
    for (const t of ticks) {
      const dec = PAIR_BY_NAME.get(t.pair)?.decimals ?? 5;
      expect(t.ts).toBe(1_000);
      expect(t.ask).toBeGreaterThan(t.bid);
      expect(Math.abs(t.bid * 10 ** dec - Math.round(t.bid * 10 ** dec))).toBeLessThan(1e-6);
      expect(Math.abs(t.ask * 10 ** dec - Math.round(t.ask * 10 ** dec))).toBeLessThan(1e-6);
    }
  });

  it('uses tight spreads for G10 pairs and wide ones for EM pairs', () => {
    const f = feed(3);
    const spreads = new Map<CurrencyPair, number[]>();
    for (let i = 0; i < 50; i++) {
      for (const t of f.tick(i)) {
        const mid = (t.bid + t.ask) / 2;
        const list = spreads.get(t.pair) ?? [];
        list.push(((t.ask - t.bid) / mid) * 1e4);
        spreads.set(t.pair, list);
      }
    }
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(spreads.get('EURUSD') ?? [])).toBeLessThan(5);
    expect(mean(spreads.get('USDMXN') ?? [])).toBeGreaterThan(3);
    expect(mean(spreads.get('USDTRY') ?? [])).toBeGreaterThan(3);
  });

  it('is deterministic for a seed and different across seeds', () => {
    const a = feed(5);
    const b = feed(5);
    const c = feed(6);
    for (let i = 0; i < 20; i++) {
      a.tick(i);
      b.tick(i);
      c.tick(i);
    }
    expect(a.tick(99)).toEqual(b.tick(99));
    expect(a.tick(100)).not.toEqual(c.tick(100));
  });

  it('walks near its start and records the latest quote', () => {
    const start = startingMids([]);
    const f = new PriceFeed(mulberry32(9), start);
    expect(f.quote('EURUSD')).toBeUndefined();
    let maxMove = 0;
    for (let i = 0; i < 3_000; i++) {
      f.tick(i);
      maxMove = Math.max(maxMove, Math.abs(f.mid('EURUSD') / start.EURUSD - 1));
    }
    expect(maxMove).toBeGreaterThan(0);
    expect(maxMove).toBeLessThan(0.05);
    expect(f.quote('EURUSD')?.ts).toBe(2_999);
  });

  it('moves prices visibly: EURUSD changes most ticks', () => {
    const f = feed(11);
    let prev = f.tick(0).find((t) => t.pair === 'EURUSD')?.bid ?? 0;
    let changed = 0;
    for (let i = 1; i <= 100; i++) {
      const bid = f.tick(i).find((t) => t.pair === 'EURUSD')?.bid ?? 0;
      if (bid !== prev) changed++;
      prev = bid;
    }
    expect(changed).toBeGreaterThan(60);
  });
});
