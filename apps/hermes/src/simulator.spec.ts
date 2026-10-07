import {
  PAIR_BY_NAME,
  mulberry32,
  parseOrderSeq,
  parseOrderEvent,
  type Order,
  type OrderEvent,
} from '@apeiron/logos';
import { describe, expect, it } from 'vitest';
import { PriceFeed, startingMids } from './price-feed.js';
import { Simulator, nextSeqFrom } from './simulator.js';
import { SEED_NOW, currentOrders } from './testing.js';

type Harness = { sim: Simulator; events: OrderEvent[]; feed: PriceFeed };

function harness(options: { seed?: number; preset?: 'medium' | 'stress'; current?: Order[]; startSeq?: number } = {}): Harness {
  const current = options.current ?? currentOrders();
  const rng = mulberry32(options.seed ?? 1);
  const feed = new PriceFeed(rng, startingMids(current));
  feed.tick(SEED_NOW);
  const events: OrderEvent[] = [];
  const sim = new Simulator({
    rng,
    feed,
    emit: (e) => events.push(e),
    preset: options.preset ?? 'medium',
    current,
    startSeq: options.startSeq ?? 100_000,
  });
  return { sim, events, feed };
}

const LATER = SEED_NOW + 3 * 86_400_000;

function run(h: Harness, from: number, seconds: number, stepMs = 100): number {
  let t = from;
  for (let i = 0; i < (seconds * 1000) / stepMs; i++) {
    t += stepMs;
    h.sim.step(t, stepMs);
  }
  return t;
}

describe('nextSeqFrom', () => {
  it('continues from the highest id', () => {
    expect(nextSeqFrom(null)).toBe(0);
    expect(nextSeqFrom('ALG01000041')).toBe(1_000_041);
    expect(() => nextSeqFrom('XYZ')).toThrow(/format/);
  });
});

describe('Simulator reconciliation', () => {
  it('fills or cancels stale LIVE orders, starts stale PENDING_START ones and tops LIVE up', () => {
    const h = harness();
    const stale = currentOrders();
    const liveBefore = stale.filter((o) => o.status === 'LIVE').length;
    const pendingBefore = stale.filter((o) => o.status === 'PENDING_START').length;
    const stats = h.sim.reconcile(LATER);

    const updates = h.events.filter((e): e is Extract<OrderEvent, { type: 'UPDATE' }> => e.type === 'UPDATE');
    const finished = updates.filter((e) => e.order.status === 'FILLED' || e.order.status === 'CANCELLED');
    const activated = updates.filter((e) => e.order.status === 'LIVE');
    // Three days later even the PENDING_START orders are past their end: they go LIVE, then complete.
    expect(activated).toHaveLength(pendingBefore);
    expect(finished).toHaveLength(liveBefore + pendingBefore);
    expect(stats.statusChanges).toBe(liveBefore + 2 * pendingBefore);
    for (const e of finished) {
      expect(e.order.completedAt).toBe(LATER);
      expect(e.order.lastUpdateTime).toBe(LATER);
      if (e.order.status === 'FILLED') {
        expect(e.order.remainingQty).toBe(0);
        expect(e.order.pctComplete).toBe(100);
        expect(e.order.filledQty).toBe(stale.find((o) => o.orderId === e.order.orderId)?.orderQty);
      }
    }
    expect(h.sim.liveCount).toBe(500);
    expect(h.sim.pendingCount).toBe(0);
    expect(stats.created).toBe(h.events.filter((e) => e.type === 'NEW').length);
    expect(stats.created).toBe(500);
  });

  it('cancels about 8% of completing orders', () => {
    const many = Array.from({ length: 2_000 }, (_, i): Order => {
      const base = currentOrders()[0] as Order;
      return { ...base, orderId: `ALG${String(i + 1).padStart(8, '0')}`, status: 'LIVE', endTime: SEED_NOW - 1, startTime: SEED_NOW - 600_000 };
    });
    const h = harness({ current: many, startSeq: 5_000 });
    h.sim.reconcile(LATER);
    const finished = h.events.filter((e) => e.type === 'UPDATE' && (e.order.status === 'FILLED' || e.order.status === 'CANCELLED'));
    const cancelled = finished.filter((e) => e.type === 'UPDATE' && e.order.status === 'CANCELLED');
    expect(finished).toHaveLength(2_000);
    expect(cancelled.length / finished.length).toBeGreaterThan(0.05);
    expect(cancelled.length / finished.length).toBeLessThan(0.11);
  });

  it('only completes LIVE orders whose end has passed and starts PENDING_START ones whose start has passed', () => {
    const current = currentOrders();
    const h = harness({ current });
    const now = SEED_NOW + 45 * 60_000;
    h.sim.reconcile(now);
    const updates = h.events.filter((e): e is Extract<OrderEvent, { type: 'UPDATE' }> => e.type === 'UPDATE');
    const expectedDone = current.filter((o) => o.status === 'LIVE' && o.endTime <= now).length;
    const expectedStarted = current.filter((o) => o.status === 'PENDING_START' && o.startTime <= now).length;
    expect(updates.filter((e) => e.order.status === 'LIVE' && e.order.completedAt === undefined)).toHaveLength(expectedStarted);
    expect(updates.filter((e) => e.order.completedAt !== undefined).length).toBeGreaterThanOrEqual(expectedDone);
    expect(expectedDone).toBeGreaterThan(0);
    expect(expectedStarted).toBeGreaterThan(0);
  });

  it('leaves fresh current orders alone', () => {
    const h = harness();
    h.sim.reconcile(SEED_NOW);
    const updates = h.events.filter((e) => e.type === 'UPDATE');
    expect(updates.every((e) => e.type === 'UPDATE' && e.order.status === 'LIVE')).toBe(true);
  });

  it('publishes reconciliation as ordinary schema-valid events', () => {
    const h = harness();
    h.sim.reconcile(LATER);
    for (const e of h.events) expect(parseOrderEvent(e).ok).toBe(true);
  });
});

describe('Simulator order ids', () => {
  it('continues above the highest existing id and stays strictly ascending', () => {
    const h = harness({ startSeq: 1_234_567 });
    h.sim.reconcile(SEED_NOW);
    run(h, SEED_NOW, 20);
    const ids = h.events.filter((e): e is Extract<OrderEvent, { type: 'NEW' }> => e.type === 'NEW').map((e) => e.order.orderId);
    expect(ids.length).toBeGreaterThan(100);
    expect(parseOrderSeq(ids[0] ?? '')).toBe(1_234_568);
    for (let i = 1; i < ids.length; i++) expect((ids[i] as string) > (ids[i - 1] as string)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^ALG\d{8}$/);
  });
});

describe('Simulator rates', () => {
  it('produces about 100 fills/s and 5 new orders/s on the medium preset', () => {
    const h = harness();
    h.sim.reconcile(SEED_NOW);
    h.events.length = 0;
    run(h, SEED_NOW, 10);
    const news = h.events.filter((e) => e.type === 'NEW').length;
    const updates = h.events.filter((e) => e.type === 'UPDATE').length;
    expect(news).toBeGreaterThan(40);
    expect(news).toBeLessThan(55);
    expect(updates).toBeGreaterThan(950);
    expect(updates).toBeLessThan(1_150);
  });

  it('splits new orders about 80/20 between LIVE and PENDING_START once the population is in steady state', () => {
    const h = harness({ seed: 4 });
    h.sim.reconcile(SEED_NOW);
    const t = run(h, SEED_NOW, 240);
    h.events.length = 0;
    run(h, t, 180);
    const news = h.events.filter((e): e is Extract<OrderEvent, { type: 'NEW' }> => e.type === 'NEW');
    const live = news.filter((e) => e.order.status === 'LIVE').length;
    expect(news.length / 180).toBeGreaterThan(4);
    expect(live / news.length).toBeGreaterThan(0.7);
    expect(live / news.length).toBeLessThan(0.95);
    expect(news.some((e) => e.order.status === 'PENDING_START')).toBe(true);
  });

  it('keeps the LIVE count inside the preset band', () => {
    const h = harness({ seed: 8 });
    h.sim.reconcile(SEED_NOW);
    let t = SEED_NOW;
    const counts: number[] = [];
    for (let s = 0; s < 240; s++) {
      t = run(h, t, 1);
      counts.push(h.sim.liveCount);
    }
    expect(Math.max(...counts)).toBeLessThanOrEqual(650);
    expect(Math.min(...counts.slice(60))).toBeGreaterThanOrEqual(380);
  });

  it('holds the stress LIVE population up instead of letting 2,000 fills/s drain it', () => {
    const h = harness({ seed: 9 });
    h.sim.reconcile(SEED_NOW);
    h.sim.setPreset('stress', SEED_NOW);
    let t = SEED_NOW;
    const counts: number[] = [];
    for (let s = 0; s < 120; s++) {
      t = run(h, t, 1);
      counts.push(h.sim.liveCount);
    }
    expect(Math.max(...counts)).toBeLessThanOrEqual(5_000);
    expect(Math.min(...counts.slice(30))).toBeGreaterThanOrEqual(1_500);
  }, 60_000);

  it('switches to the stress preset live: 2,000 fills/s, 50 new/s, LIVE cap 5,000', () => {
    const h = harness({ seed: 2 });
    h.sim.reconcile(SEED_NOW);
    h.sim.setPreset('stress', SEED_NOW);
    expect(h.sim.preset).toBe('stress');
    expect(h.sim.liveCount).toBe(3_000);
    h.events.length = 0;
    run(h, SEED_NOW, 5);
    const updates = h.events.filter((e) => e.type === 'UPDATE').length;
    const news = h.events.filter((e) => e.type === 'NEW').length;
    expect(updates / 5).toBeGreaterThan(1_800);
    expect(updates / 5).toBeLessThan(2_400);
    expect(news / 5).toBeGreaterThan(40);
    expect(h.sim.liveCount).toBeLessThanOrEqual(5_000);
  });

  it('carries fractional events across steps (rates hold for any step length)', () => {
    const coarse = harness({ seed: 3 });
    coarse.sim.reconcile(SEED_NOW);
    coarse.events.length = 0;
    run(coarse, SEED_NOW, 10, 250);
    const fine = harness({ seed: 3 });
    fine.sim.reconcile(SEED_NOW);
    fine.events.length = 0;
    run(fine, SEED_NOW, 10, 20);
    const updates = (h: Harness): number => h.events.filter((e) => e.type === 'UPDATE').length;
    expect(Math.abs(updates(coarse) - updates(fine))).toBeLessThan(120);
  });
});

describe('Simulator lifecycle', () => {
  it('starts PENDING_START orders at their start time', () => {
    const current = currentOrders();
    const pending = current.find((o) => o.status === 'PENDING_START') as Order;
    const h = harness({ current });
    h.sim.reconcile(SEED_NOW);
    expect(h.sim.order(pending.orderId)?.status).toBe('PENDING_START');
    h.events.length = 0;
    h.sim.step(pending.startTime + 1, 100);
    const start = h.events.find((e) => e.type === 'UPDATE' && e.order.orderId === pending.orderId);
    expect(start).toMatchObject({ type: 'UPDATE', order: { status: 'LIVE' } });
    expect(h.sim.order(pending.orderId)?.status).toBe('LIVE');
  });

  it('emits absolute fill values that agree with the simulator state', () => {
    const h = harness({ seed: 6 });
    h.sim.reconcile(SEED_NOW);
    h.events.length = 0;
    run(h, SEED_NOW, 5);
    const fills = h.events.filter((e): e is Extract<OrderEvent, { type: 'UPDATE' }> => e.type === 'UPDATE' && e.order.filledQty !== undefined);
    expect(fills.length).toBeGreaterThan(100);
    for (const e of fills) {
      const o = e.order;
      expect(o.remainingQty).toBeDefined();
      expect(o.numFills).toBeGreaterThan(0);
      expect(o.avgFillPrice).not.toBeNull();
      expect(o.lastUpdateTime).toBe(e.ts);
    }
    const last = new Map<string, Partial<Order>>();
    for (const e of fills) last.set(e.order.orderId, { ...last.get(e.order.orderId), ...e.order });
    for (const [id, merged] of last) {
      const state = h.sim.order(id);
      if (state !== undefined) expect(state.filledQty).toBe(merged.filledQty);
    }
  });

  it('prices fills around the current mid', () => {
    const h = harness({ seed: 6 });
    h.sim.reconcile(SEED_NOW);
    h.events.length = 0;
    run(h, SEED_NOW, 3);
    const fills = h.events.filter((e): e is Extract<OrderEvent, { type: 'UPDATE' }> => e.type === 'UPDATE' && e.order.lastFillPrice !== undefined && e.order.lastFillPrice !== null);
    for (const e of fills) {
      const order = h.sim.order(e.order.orderId);
      const pair = order?.currencyPair;
      if (pair === undefined) continue;
      const mid = h.feed.mid(pair);
      expect(Math.abs((e.order.lastFillPrice as number) / mid - 1)).toBeLessThan(0.001);
      const dec = PAIR_BY_NAME.get(pair)?.decimals ?? 5;
      expect(Math.abs((e.order.lastFillPrice as number) * 10 ** dec - Math.round((e.order.lastFillPrice as number) * 10 ** dec))).toBeLessThan(1e-6);
    }
  });

  it('completes orders at their end time and produces the occasional expiry cancel', () => {
    const h = harness({ seed: 12 });
    h.sim.reconcile(SEED_NOW);
    h.events.length = 0;
    run(h, SEED_NOW, 120);
    const terminal = h.events.filter((e): e is Extract<OrderEvent, { type: 'UPDATE' }> => e.type === 'UPDATE' && (e.order.status === 'FILLED' || e.order.status === 'CANCELLED'));
    expect(terminal.length).toBeGreaterThan(50);
    expect(terminal.some((e) => e.order.status === 'FILLED')).toBe(true);
    expect(terminal.some((e) => e.order.status === 'CANCELLED')).toBe(true);
    const finished = new Set(terminal.map((e) => e.order.orderId));
    for (const id of finished) expect(h.sim.order(id)).toBeUndefined();
  });

  it('never fills PAUSED orders', () => {
    const current = currentOrders();
    const paused = current.filter((o) => o.status === 'LIVE').slice(0, 5).map((o): Order => ({ ...o, status: 'PAUSED', endTime: SEED_NOW + 86_400_000 }));
    const rest = current.filter((o) => !paused.some((p) => p.orderId === o.orderId));
    const h = harness({ current: [...rest, ...paused] });
    h.sim.reconcile(SEED_NOW);
    h.events.length = 0;
    run(h, SEED_NOW, 20);
    const pausedIds = new Set(paused.map((o) => o.orderId));
    expect(h.events.some((e) => e.type === 'UPDATE' && pausedIds.has(e.order.orderId))).toBe(false);
  });

  it('NEW events carry the complete 50-field order with the current mid and no fills', () => {
    const h = harness();
    h.sim.reconcile(SEED_NOW);
    const news = h.events.filter((e): e is Extract<OrderEvent, { type: 'NEW' }> => e.type === 'NEW');
    expect(news.length).toBeGreaterThan(0);
    for (const e of news) {
      expect(Object.keys(e.order)).toHaveLength(50);
      expect(e.order.filledQty).toBe(0);
      expect(e.order.createdAt).toBe(e.ts);
      expect(e.order.marketMid).toBeCloseTo(h.feed.mid(e.order.currencyPair), 2);
      expect(['LIVE', 'PENDING_START']).toContain(e.order.status);
    }
  });

  it('is deterministic for a seed', () => {
    const a = harness({ seed: 21 });
    const b = harness({ seed: 21 });
    for (const h of [a, b]) {
      h.sim.reconcile(SEED_NOW);
      run(h, SEED_NOW, 5);
    }
    expect(a.events).toEqual(b.events);
    expect(a.events.length).toBeGreaterThan(500);
  });
});
