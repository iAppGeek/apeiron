import {
  PAIR_BY_NAME,
  applyExecReport,
  formatOrderId,
  mulberry32,
  parseOrderSeq,
  parseExecReport,
  pnlUsdOf,
  type ExecReport,
  type Order,
  type VenueInstruction,
  type OrderStateRecord,
} from '@apeiron/logos';
import { describe, expect, it } from 'vitest';
import type { QuoteBook } from './quotes.js';
import { Simulator, type ReportSink } from './simulator.js';
import { SEED_NOW, currentOrders, quoteBookFor } from './testing.js';

/** What the lifecycle did, as the tests read it: an order arriving, or an order's changed fields. */
type TestEvent =
  | { type: 'UPDATE'; order: Partial<Order> & { orderId: string }; ts: number; commandId?: string }
  | { type: 'NEW'; order: Order; ts: number }
  | Extract<ExecReport, { type: 'VENUE_REJECT' }>;

type Harness = { sim: Simulator; events: TestEvent[]; feed: QuoteBook; reports: ExecReport[]; records: Map<string, OrderStateRecord> };

/** A promise-shaped value that has already settled, so a submission is tracked in the same call. */
const settled = <T,>(value: T): Promise<T> => ({ then: (onFulfilled: (v: T) => unknown) => onFulfilled(value) }) as unknown as Promise<T>;

const diff = (before: Order, after: Order): Partial<Order> => {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(after) as (keyof Order)[]) if (after[key] !== before[key]) out[key] = after[key];
  return out as Partial<Order>;
};

/**
 * The simulator on its own, with the order service stood in for by the shared rules: every report it sends is applied
 * with `applyExecReport` to the order service's record of the order, and what changed is kept as an UPDATE (with the
 * command's id when the report answers a command), so the lifecycle can be read as before. A submission is accepted at
 * once and given the next id; a refused command's answer is kept as a REJECT.
 */
function harness(options: { seed?: number; preset?: 'medium' | 'stress'; current?: Order[]; startSeq?: number } = {}): Harness {
  const current = options.current ?? currentOrders();
  const rng = mulberry32(options.seed ?? 1);
  const feed = quoteBookFor(current);
  const events: TestEvent[] = [];
  const reports: ExecReport[] = [];
  const records = new Map<string, OrderStateRecord>();
  for (const order of current) records.set(order.orderId, { v: 1, execSeq: 0, srcTs: order.lastUpdateTime, order: structuredClone(order) });
  let seq = options.startSeq ?? 100_000;
  const sink: ReportSink = {
    report: (report) => {
      reports.push(report);
      if (report.type === 'VENUE_REJECT') events.push(report);
      const record = records.get(report.orderId);
      if (record === undefined) return;
      const result = applyExecReport(record, report);
      if (result.kind === 'duplicate') return;
      records.set(report.orderId, result.record);
      if (result.kind !== 'applied') return;
      const instrId = 'instrId' in report ? report.instrId : undefined;
      events.push({
        type: 'UPDATE',
        order: { orderId: report.orderId, ...diff(record.order, result.record.order), lastUpdateTime: result.record.order.lastUpdateTime },
        ts: report.ts,
        ...(instrId === undefined ? {} : { commandId: instrId }),
      });
    },
    submit: (submission) => {
      const orderId = formatOrderId(++seq);
      const order = { ...submission.order, orderId } as Order;
      records.set(orderId, { v: 1, execSeq: 0, srcTs: order.createdAt, order });
      events.push({ type: 'NEW', order, ts: order.createdAt });
      return settled({ ok: true as const, orderId, v: 1 });
    },
  };
  const sim = new Simulator({ rng, feed, reports: sink, preset: options.preset ?? 'medium', runTag: 'test' });
  for (const order of current) sim.syncRecord(records.get(order.orderId) as OrderStateRecord);
  return { sim, events, feed, reports, records };
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

describe('Simulator reconciliation', () => {
  it('fills or cancels stale LIVE orders, starts stale PENDING_START ones and tops LIVE up', () => {
    const h = harness();
    const stale = currentOrders();
    const liveBefore = stale.filter((o) => o.status === 'LIVE').length;
    const pendingBefore = stale.filter((o) => o.status === 'PENDING_START').length;
    const stats = h.sim.reconcile(LATER);

    const updates = h.events.filter((e): e is Extract<TestEvent, { type: 'UPDATE' }> => e.type === 'UPDATE');
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
    const updates = h.events.filter((e): e is Extract<TestEvent, { type: 'UPDATE' }> => e.type === 'UPDATE');
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

  it('publishes reconciliation as schema-valid execution reports and submissions', () => {
    const h = harness();
    h.sim.reconcile(LATER);
    expect(h.reports.length).toBeGreaterThan(0);
    for (const r of h.reports) expect(parseExecReport(r).ok).toBe(true);
  });
});

describe('Simulator order ids', () => {
  it('continues above the highest existing id and stays strictly ascending', () => {
    const h = harness({ startSeq: 1_234_567 });
    h.sim.reconcile(SEED_NOW);
    run(h, SEED_NOW, 20);
    const ids = h.events.filter((e): e is Extract<TestEvent, { type: 'NEW' }> => e.type === 'NEW').map((e) => e.order.orderId);
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
    const news = h.events.filter((e): e is Extract<TestEvent, { type: 'NEW' }> => e.type === 'NEW');
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
    // Allows for random variation around the 400 floor; the point is that fills cannot drain the population.
    expect(Math.min(...counts.slice(60))).toBeGreaterThanOrEqual(350);
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
    const fills = h.events.filter((e): e is Extract<TestEvent, { type: 'UPDATE' }> => e.type === 'UPDATE' && e.order.filledQty !== undefined);
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
    const fills = h.events.filter((e): e is Extract<TestEvent, { type: 'UPDATE' }> => e.type === 'UPDATE' && e.order.lastFillPrice !== undefined && e.order.lastFillPrice !== null);
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
    const terminal = h.events.filter((e): e is Extract<TestEvent, { type: 'UPDATE' }> => e.type === 'UPDATE' && (e.order.status === 'FILLED' || e.order.status === 'CANCELLED'));
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
    const news = h.events.filter((e): e is Extract<TestEvent, { type: 'NEW' }> => e.type === 'NEW');
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

describe('Simulator commands', () => {
  const command = (orderId: string, action: 'CANCEL' | 'PAUSE' | 'RESUME', n = 1): VenueInstruction => ({ orderId, action, ts: SEED_NOW, instrId: `c:${n}` });
  const liveId = (h: Harness): string => {
    const id = currentOrders().find((o) => h.sim.order(o.orderId)?.status === 'LIVE')?.orderId;
    if (id === undefined) throw new Error('no live order');
    return id;
  };
  const last = (h: Harness): TestEvent => h.events[h.events.length - 1] as TestEvent;

  it('pauses a LIVE order and reports it, naming the instruction', () => {
    const h = harness();
    const id = liveId(h);
    const liveBefore = h.sim.liveCount;
    h.sim.instruct(command(id, 'PAUSE'), SEED_NOW + 5);
    expect(last(h)).toMatchObject({ type: 'UPDATE', commandId: 'c:1', ts: SEED_NOW + 5, order: { orderId: id, status: 'PAUSED' } });
    expect(h.sim.order(id)?.status).toBe('PAUSED');
    expect(h.sim.liveCount).toBe(liveBefore - 1);
  });

  it('gives a PAUSED order no fills, and resuming restarts them', () => {
    const h = harness();
    const id = liveId(h);
    h.sim.instruct(command(id, 'PAUSE'), SEED_NOW);
    h.events.length = 0;
    const t = run(h, SEED_NOW, 20);
    const touching = (): TestEvent[] => h.events.filter((e) => e.type === 'UPDATE' && e.order.orderId === id);
    expect(touching()).toEqual([]);

    h.sim.instruct(command(id, 'RESUME', 2), t);
    expect(last(h)).toMatchObject({ type: 'UPDATE', commandId: 'c:2', order: { orderId: id, status: 'LIVE' } });
    h.events.length = 0;
    run(h, t, 60);
    expect(touching().length).toBeGreaterThan(0);
  });

  it('pushes the end time out by the time spent paused, so a resumed order is not completed at once', () => {
    const h = harness();
    const id = liveId(h);
    const endTime = h.sim.order(id)?.endTime as number;
    h.sim.instruct(command(id, 'PAUSE'), SEED_NOW);
    // Paused for far longer than the order had left.
    const resumeAt = endTime + 10 * 60_000;
    h.sim.instruct(command(id, 'RESUME', 2), resumeAt);
    expect(last(h)).toMatchObject({ commandId: 'c:2', order: { status: 'LIVE', endTime: endTime + (resumeAt - SEED_NOW) } });
    h.events.length = 0;
    h.sim.step(resumeAt + 1_000, 1_000);
    expect(h.events.filter((e) => e.type === 'UPDATE' && e.order.orderId === id && e.order.status !== undefined)).toEqual([]);
  });

  it('cancels LIVE, PAUSED and PENDING_START orders and then forgets them', () => {
    const h = harness();
    const live = liveId(h);
    const pending = currentOrders().find((o) => o.status === 'PENDING_START')?.orderId as string;
    h.sim.instruct(command(live, 'PAUSE'), SEED_NOW);
    h.sim.instruct(command(live, 'CANCEL', 2), SEED_NOW);
    expect(last(h)).toMatchObject({ commandId: 'c:2', order: { status: 'CANCELLED', completedAt: SEED_NOW } });
    h.sim.instruct(command(pending, 'CANCEL', 3), SEED_NOW);
    expect(last(h)).toMatchObject({ commandId: 'c:3', order: { orderId: pending, status: 'CANCELLED' } });
    expect(h.sim.order(live)).toBeUndefined();
    expect(h.sim.order(pending)).toBeUndefined();
  });

  it('refuses invalid transitions with a VENUE_REJECT and changes nothing', () => {
    const h = harness();
    const id = liveId(h);
    const pending = currentOrders().find((o) => o.status === 'PENDING_START')?.orderId as string;
    for (const [orderId, action] of [
      [id, 'RESUME'],
      [pending, 'PAUSE'],
      [pending, 'RESUME'],
    ] as const) {
      h.sim.instruct(command(orderId, action, 9), SEED_NOW);
      expect(last(h)).toMatchObject({ type: 'VENUE_REJECT', instrId: 'c:9', orderId, message: expect.stringMatching(/^Cannot /) });
    }
    expect(h.sim.order(id)?.status).toBe('LIVE');
    // A cancelled order is no longer held, so a second CANCEL is refused as an order the venue does not have.
    h.sim.instruct(command(id, 'CANCEL', 10), SEED_NOW);
    h.sim.instruct(command(id, 'CANCEL', 11), SEED_NOW);
    expect(last(h)).toMatchObject({ type: 'VENUE_REJECT', instrId: 'c:11', message: `Order ${id} is not active at the venue` });
  });

  it('refuses an order it does not hold with a VENUE_REJECT that the order service can match to the instruction', () => {
    const h = harness();
    h.sim.instruct(command('ALG00000001', 'CANCEL', 4), SEED_NOW);
    expect(parseExecReport(last(h)).ok).toBe(true);
    expect(last(h)).toEqual({
      type: 'VENUE_REJECT',
      orderId: 'ALG00000001',
      execSeq: 1,
      instrId: 'c:4',
      message: 'Order ALG00000001 is not active at the venue',
      ts: SEED_NOW,
    });
  });

  it('does not remember an order it never held after refusing it', () => {
    const h = harness();
    h.sim.instruct(command('ALG00000001', 'CANCEL', 4), SEED_NOW);
    h.sim.instruct(command('ALG00000001', 'CANCEL', 5), SEED_NOW);
    expect(h.reports.map((r) => r.execSeq)).toEqual([1, 1]);
  });
});

describe('Simulator completions send the quote the order service stores', () => {
  const cmd = (orderId: string, action: VenueInstruction['action']): VenueInstruction => ({ orderId, action, ts: SEED_NOW, instrId: `c:${orderId}:${action}` });
  const recordOf = (h: Harness, orderId: string): Order => (h.records.get(orderId) as OrderStateRecord).order;

  it('cancels with the feed quote: the stored snapshot is that quote and the realised P&L is measured at its mid, not at the stale unrealised value', () => {
    const base = currentOrders().find((o) => o.status === 'LIVE') as Order;
    const live: Order = {
      ...base,
      marketBid: 0.5,
      marketAsk: 0.6,
      marketMid: 0.55,
      filledQty: 400_000,
      remainingQty: base.orderQty - 400_000,
      avgFillPrice: base.arrivalPrice * 0.99,
      unrealisedPnlUsd: 123_456,
    };
    const h = harness({ current: [live] });
    h.sim.instruct(cmd(live.orderId, 'CANCEL'), SEED_NOW);
    const quote = h.feed.quote(live.currencyPair);
    const stored = recordOf(h, live.orderId);
    expect(h.reports[0]).toMatchObject({ type: 'CANCELLED', bid: quote?.bid, ask: quote?.ask });
    expect(stored).toMatchObject({ status: 'CANCELLED', marketBid: quote?.bid, marketAsk: quote?.ask, unrealisedPnlUsd: 0 });
    expect(stored.realisedPnlUsd).toBe(pnlUsdOf({ ...live, avgFillPrice: live.avgFillPrice }, stored.marketMid));
    expect(stored.realisedPnlUsd).not.toBe(123_456);
  });

  it('completes an expiring order with a fill of the remainder that carries the same quote', () => {
    const base = currentOrders().find((o) => o.status === 'LIVE') as Order;
    const live: Order = { ...base, endTime: SEED_NOW - 1, filledQty: 100_000, remainingQty: base.orderQty - 100_000, avgFillPrice: base.arrivalPrice };
    let found = false;
    for (let seed = 1; seed < 40 && !found; seed++) {
      const h = harness({ current: [live], seed });
      h.sim.reconcile(SEED_NOW + 1);
      const stored = recordOf(h, live.orderId);
      if (stored.status !== 'FILLED') continue;
      found = true;
      const quote = h.feed.quote(live.currencyPair);
      expect(h.reports[0]).toMatchObject({ type: 'FILL', qty: live.remainingQty, bid: quote?.bid, ask: quote?.ask });
      expect(stored).toMatchObject({ marketBid: quote?.bid, marketAsk: quote?.ask, unrealisedPnlUsd: 0, remainingQty: 0 });
      expect(stored.realisedPnlUsd).toBe(pnlUsdOf(stored, stored.marketMid));
    }
    expect(found).toBe(true);
  });

  it('sends no snapshot with a pause: the stored market fields stay as they were', () => {
    const live = { ...(currentOrders().find((o) => o.status === 'LIVE') as Order), marketBid: 0.5, marketAsk: 0.6, marketMid: 0.55 };
    const h = harness({ current: [live] });
    h.sim.instruct(cmd(live.orderId, 'PAUSE'), SEED_NOW);
    expect(h.reports[0]).toMatchObject({ type: 'PAUSED' });
    expect(recordOf(h, live.orderId)).toMatchObject({ status: 'PAUSED', marketBid: 0.5, marketAsk: 0.6 });
  });
});
