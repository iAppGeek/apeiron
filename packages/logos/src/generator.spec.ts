import { describe, expect, it } from 'vitest';
import {
  currentOrderCounts,
  generateOrderBatches,
  generateOrders,
  historicalDays,
} from './generator.js';
import type { Order } from './order.js';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const DAY = 86_400_000;

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
    for (let i = 0; i < hist.length; i++) {
      const o = hist[i]!;
      if (i > 0) expect(o.createdAt).toBeGreaterThanOrEqual(hist[i - 1]!.createdAt);
      expect(days.has(Math.floor(o.createdAt / DAY) * DAY)).toBe(true);
      expect(o.createdAt).toBeLessThan(NOW);
      expect(o.completedAt).not.toBeNull();
      expect(o.completedAt!).toBeLessThan(NOW);
      expect(o.endTime).toBeLessThanOrEqual(NOW);
    }
  });

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
    for (const o of orders) {
      expect(Object.keys(o)).toHaveLength(50);
      expect(o.orderQty % 100_000).toBe(0);
      expect(o.orderQty).toBeGreaterThanOrEqual(1_000_000);
      expect(o.orderQty).toBeLessThanOrEqual(100_000_000);
      expect(o.remainingQty).toBe(o.orderQty - o.filledQty);
      expect(o.pctComplete).toBeCloseTo((o.filledQty / o.orderQty) * 100, 1);
      expect(o.marketBid).toBeLessThan(o.marketAsk);
      expect(o.marketMid).toBeGreaterThanOrEqual(o.marketBid);
      expect(o.marketMid).toBeLessThanOrEqual(o.marketAsk);
      expect(o.spreadBps).toBeGreaterThan(0);
      expect(o.startTime).toBeGreaterThanOrEqual(o.createdAt);
      expect(o.endTime).toBeGreaterThan(o.startTime);
      expect(o.baseCcy + o.quoteCcy).toBe(o.currencyPair);
      expect(o.traderId).toMatch(/^T[1-5]$/);
      expect(o.account.startsWith(o.traderId)).toBe(true);
      if (o.orderType === 'MARKET') {
        expect(o.limitPrice).toBeNull();
        expect(o.distanceToLimitBps).toBeNull();
      } else {
        expect(o.limitPrice).not.toBeNull();
      }
      if (o.status === 'FILLED') {
        expect(o.filledQty).toBe(o.orderQty);
        expect(o.remainingQty).toBe(0);
      }
      if (o.status === 'CANCELLED') {
        expect(o.filledQty).toBeGreaterThan(0);
        expect(o.filledQty).toBeLessThan(o.orderQty);
      }
      if (o.filledQty > 0) {
        expect(o.avgFillPrice).not.toBeNull();
        expect(o.numFills).toBeGreaterThanOrEqual(1);
        expect(o.lastFillQty).toBeGreaterThan(0);
        expect(o.lastFillQty).toBeLessThanOrEqual(o.filledQty);
        expect(o.numChildOrders).toBeGreaterThanOrEqual(o.numFills);
      }
    }
  });

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
