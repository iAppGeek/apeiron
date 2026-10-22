import { describe, expect, it } from 'vitest';
import {
  currentOrderCounts,
  finalMids,
  generateOrderBatches,
  generateOrders,
  historicalDays,
} from './generator.js';
import { PAIR_BY_NAME, PAIRS, type CurrencyPair, type Order } from './order.js';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const DAY = 86_400_000;
/** Explicit budget for the tests that walk 100k generated orders with per-field assertions. */
const HEAVY_MS = 30_000;

/**
 * Checks every order against named rules and lists the first few that break, as "<orderId>: <rule>". Plain checks
 * with one assertion at the end: an expect() per field over 100k orders is millions of calls, which a busy CI runner
 * could not finish within HEAVY_MS.
 */
function violations(list: Order[], rules: Record<string, (o: Order, i: number) => boolean>): string[] {
  const out: string[] = [];
  const checks = Object.entries(rules);
  for (let i = 0; i < list.length && out.length < 20; i++) {
    const o = list[i]!;
    for (const [name, ok] of checks) if (!ok(o, i)) out.push(`${o.orderId}: ${name}`);
  }
  return out;
}

function first(n: number, total: number, seed = 42): Order[] {
  const out: Order[] = [];
  for (const batch of generateOrderBatches({ seed, n: total, now: NOW, batchSize: n })) {
    out.push(...batch);
    break;
  }
  return out;
}

describe('generator determinism', () => {
  it('matches the snapshot of the first 100 rows for seed 42', () => {
    expect(first(100, 1_000_000)).toMatchSnapshot();
  });

  it('gives identical streams for identical inputs and different ones for another seed', () => {
    const a = [...generateOrders(42, 3000, NOW)];
    const b = [...generateOrders(42, 3000, NOW)];
    const c = [...generateOrders(43, 3000, NOW)];
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('yields exactly n orders in batches of the requested size', () => {
    const batches = [...generateOrderBatches({ seed: 1, n: 2500, now: NOW, batchSize: 1000 })];
    expect(batches.map((b) => b.length)).toEqual([1000, 1000, 500]);
    expect(generateOrderBatches({ seed: 1, n: 0, now: NOW }).next().done).toBe(true);
  });

  it('produces the same rows regardless of batch size', () => {
    const flat = (size: number): Order[] =>
      [...generateOrderBatches({ seed: 9, n: 2000, now: NOW, batchSize: size })].flat();
    expect(flat(333)).toEqual(flat(10_000));
  });
});

describe('generated data shape', () => {
  const n = 100_000;
  const orders = [...generateOrders(42, n, NOW)];

  it('has unique, zero-padded, ascending order IDs', () => {
    expect(orders).toHaveLength(n);
    expect(orders[0]?.orderId).toBe('ALG00000001');
    expect(orders[n - 1]?.orderId).toBe(`ALG${String(n).padStart(8, '0')}`);
    for (let i = 1; i < n; i++) expect(orders[i]!.orderId > orders[i - 1]!.orderId).toBe(true);
  });

  it('has the expected number of LIVE and PENDING_START orders after all historical ones', () => {
    const counts = currentOrderCounts(n);
    expect(counts).toEqual({ live: 40, pending: 20 });
    const firstCurrent = orders.findIndex((o) => o.status === 'LIVE' || o.status === 'PENDING_START');
    expect(firstCurrent).toBe(n - 60);
    expect(orders.filter((o) => o.status === 'LIVE')).toHaveLength(40);
    expect(orders.filter((o) => o.status === 'PENDING_START')).toHaveLength(20);
    expect(currentOrderCounts(1_000_000)).toEqual({ live: 400, pending: 200 });
  });

  it('keeps historical createdAt ascending, on weekdays, within the last 182 days', () => {
    const hist = orders.filter((o) => o.status === 'FILLED' || o.status === 'CANCELLED');
    const days = new Set(historicalDays(NOW));
    expect(days.size).toBeGreaterThan(120);
    const broken = violations(hist, {
      ascending: (o, i) => i === 0 || o.createdAt >= hist[i - 1]!.createdAt,
      'on a historical weekday': (o) => days.has(Math.floor(o.createdAt / DAY) * DAY),
      'created before now': (o) => o.createdAt < NOW,
      'completed before now': (o) => o.completedAt !== null && o.completedAt < NOW,
      'ended by now': (o) => o.endTime <= NOW,
    });
    expect(broken).toEqual([]);
  }, HEAVY_MS);

  it('places LIVE orders in progress and PENDING_START orders 1-120 minutes ahead', () => {
    for (const o of orders.filter((x) => x.status === 'LIVE')) {
      expect(o.startTime).toBeLessThanOrEqual(NOW);
      expect(o.endTime).toBeGreaterThan(NOW);
      expect(o.filledQty).toBeGreaterThan(0);
      expect(o.filledQty).toBeLessThan(o.orderQty);
      expect(o.completedAt).toBeNull();
    }
    for (const o of orders.filter((x) => x.status === 'PENDING_START')) {
      const ahead = (o.startTime - NOW) / 60_000;
      expect(ahead).toBeGreaterThanOrEqual(1);
      expect(ahead).toBeLessThanOrEqual(120);
      expect(o.filledQty).toBe(0);
      expect(o.avgFillPrice).toBeNull();
      expect(o.numFills).toBe(0);
    }
  });

  it('keeps every order internally consistent', () => {
    const broken = violations(orders, {
      '50 fields': (o) => Object.keys(o).length === 50,
      'qty in 100k lots': (o) => o.orderQty % 100_000 === 0,
      'qty within 1M-100M': (o) => o.orderQty >= 1_000_000 && o.orderQty <= 100_000_000,
      'remaining = order - filled': (o) => o.remainingQty === o.orderQty - o.filledQty,
      // The same tolerance as toBeCloseTo(x, 1).
      'pctComplete matches': (o) => Math.abs(o.pctComplete - (o.filledQty / o.orderQty) * 100) < 0.05,
      'bid < ask': (o) => o.marketBid < o.marketAsk,
      'mid within bid/ask': (o) => o.marketMid >= o.marketBid && o.marketMid <= o.marketAsk,
      'positive spread': (o) => o.spreadBps > 0,
      'starts after creation': (o) => o.startTime >= o.createdAt,
      'ends after start': (o) => o.endTime > o.startTime,
      'pair = base + quote': (o) => o.baseCcy + o.quoteCcy === o.currencyPair,
      'trader T1-T5': (o) => /^T[1-5]$/.test(o.traderId),
      "account is the trader's": (o) => o.account.startsWith(o.traderId),
      'limit price matches type': (o) =>
        o.orderType === 'MARKET' ? o.limitPrice === null && o.distanceToLimitBps === null : o.limitPrice !== null,
      'FILLED is fully filled': (o) => o.status !== 'FILLED' || (o.filledQty === o.orderQty && o.remainingQty === 0),
      'CANCELLED is part filled': (o) => o.status !== 'CANCELLED' || (o.filledQty > 0 && o.filledQty < o.orderQty),
      'fills are consistent': (o) =>
        o.filledQty === 0 ||
        (o.avgFillPrice !== null &&
          o.numFills >= 1 &&
          o.lastFillQty > 0 &&
          o.lastFillQty <= o.filledQty &&
          o.numChildOrders >= o.numFills),
    });
    expect(broken).toEqual([]);
  }, HEAVY_MS);

  it('computes slippage with a positive value meaning adverse', () => {
    for (const o of orders.slice(0, 2000)) {
      if (o.avgFillPrice === null || o.slippageBps === null) continue;
      const sign = o.side === 'BUY' ? 1 : -1;
      const expected = (sign * (o.avgFillPrice - o.arrivalPrice) * 1e4) / o.arrivalPrice;
      expect(o.slippageBps).toBeCloseTo(expected, 1);
    }
  });

  it('follows the requested distributions', () => {
    const hist = orders.filter((o) => o.status === 'FILLED' || o.status === 'CANCELLED');
    const frac = (pred: (o: Order) => boolean): number => hist.filter(pred).length / hist.length;
    expect(frac((o) => o.status === 'FILLED')).toBeCloseTo(0.92, 1);
    expect(frac((o) => o.side === 'BUY')).toBeCloseTo(0.5, 1);
    expect(frac((o) => o.traderId === 'T1')).toBeCloseTo(0.35, 1);
    expect(frac((o) => o.traderId === 'T5')).toBeCloseTo(0.08, 1);
    expect(frac((o) => o.currencyPair === 'EURUSD')).toBeCloseTo(0.25, 1);
    expect(frac((o) => o.algoType === 'TWAP')).toBeCloseTo(0.3, 1);
    const meanSlip =
      hist.reduce((s, o) => s + (o.slippageBps ?? 0), 0) / hist.filter((o) => o.slippageBps !== null).length;
    expect(meanSlip).toBeGreaterThan(0.2);
    expect(meanSlip).toBeLessThan(0.8);
  });

  it('concentrates historical flow in London hours', () => {
    const hist = orders.filter((o) => o.status === 'FILLED' || o.status === 'CANCELLED');
    const inHours = hist.filter((o) => {
      const h = new Date(o.createdAt).getUTCHours();
      return h >= 7 && h < 17;
    }).length;
    expect(inHours / hist.length).toBeCloseTo(0.85, 1);
  });
});

describe('historicalDays', () => {
  it('lists only weekdays before today, oldest first', () => {
    const days = historicalDays(NOW);
    expect(days[0]).toBeGreaterThanOrEqual(Math.floor(NOW / DAY) * DAY - 182 * DAY);
    expect(days[days.length - 1]).toBeLessThan(Math.floor(NOW / DAY) * DAY);
    for (const d of days) expect([1, 2, 3, 4, 5]).toContain(new Date(d).getUTCDay());
    expect([...days].sort((a, b) => a - b)).toEqual(days);
  });
});

describe('finalMids', () => {
  const n = 100_000;

  it('matches the marketMid of every LIVE and PENDING_START order', () => {
    const mids = finalMids(42, n, NOW);
    const round = (v: number, d: number): number => Math.round(v * 10 ** d) / 10 ** d;
    const current = [...generateOrders(42, n, NOW)].filter((o) => o.status === 'LIVE' || o.status === 'PENDING_START');
    expect(current).toHaveLength(60);
    for (const o of current) {
      const dec = PAIR_BY_NAME.get(o.currencyPair)?.decimals ?? 0;
      expect(o.marketMid).toBe(round(mids[o.currencyPair], dec));
    }
  }, HEAVY_MS);

  it('covers all pairs, is deterministic, and drifts away from the reference levels', () => {
    const a = finalMids(42, 5000, NOW);
    expect(Object.keys(a).sort()).toEqual(PAIRS.map((p) => p.pair).sort());
    expect(finalMids(42, 5000, NOW)).toEqual(a);
    expect(finalMids(43, 5000, NOW)).not.toEqual(a);
    const eurusd: CurrencyPair = 'EURUSD';
    expect(a[eurusd]).not.toBe(1.08);
  });
});

describe('order ids and the order factory', () => {
  it('formats and parses ALG ids', async () => {
    const { formatOrderId, parseOrderSeq } = await import('./generator.js');
    expect(formatOrderId(42)).toBe('ALG00000042');
    expect(parseOrderSeq('ALG00000042')).toBe(42);
    expect(parseOrderSeq('PAR00000042')).toBeNull();
    expect(parseOrderSeq('ALG42')).toBeNull();
  });

  it('builds a complete order that continues the id sequence', async () => {
    const { OrderFactory, mulberry32 } = await import('./index.js');
    const factory = new OrderFactory(mulberry32(7));
    factory.seq = 1_000_041;
    const order = factory.create({
      status: 'LIVE',
      createdAt: 1_000,
      startTime: 1_000,
      durationMins: 5,
      fillFraction: 0,
      completedAt: null,
      now: 1_000,
      current: true,
    });
    expect(order.orderId).toBe('ALG01000042');
    expect(Object.keys(order)).toHaveLength(50);
    expect(order.filledQty).toBe(0);
    expect(order.avgFillPrice).toBeNull();
  });
});
