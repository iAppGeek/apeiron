import { PAIRS, PAIR_BY_NAME, mulberry32, type CurrencyPair } from '@apeiron/logos';
import { describe, expect, it } from 'vitest';
import { PriceFeed, referenceMids } from './price-feed.js';

function feed(seed = 1, start = referenceMids()): PriceFeed {
  return new PriceFeed(mulberry32(seed), start);
}

describe('referenceMids', () => {
  it('has the reference level of every pair', () => {
    const mids = referenceMids();
    expect(Object.keys(mids)).toHaveLength(PAIRS.length);
    for (const p of PAIRS) expect(mids[p.pair]).toBe(p.mid);
  });
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
    const start = referenceMids();
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
