import {
  applyExecReport,
  mulberry32,
  type ExecReport,
  type Order,
  type OrderCommand,
  type OrderEvent,
  type OrderStateRecord,
  type Submission,
  type SubmitReply,
} from '@apeiron/logos';
import { describe, expect, it } from 'vitest';
import { Simulator, type ReportSink } from './simulator.js';
import { SEED_NOW, currentOrders, quoteBookFor } from './testing.js';

type Rig = {
  sim: Simulator;
  reports: ExecReport[];
  submissions: Submission[];
  answers: OrderEvent[];
  /** Replies to every submission still waiting. */
  flush(): Promise<void>;
};

const LATER = SEED_NOW + 3 * 86_400_000;

function rig(options: { current?: Order[]; hold?: boolean; reject?: boolean; seed?: number } = {}): Rig {
  const reports: ExecReport[] = [];
  const submissions: Submission[] = [];
  const answers: OrderEvent[] = [];
  const waiting: (() => void)[] = [];
  let n = 0;
  const sink: ReportSink = {
    report: (r) => reports.push(r),
    answer: (a) => answers.push(a),
    submit: (s) => {
      submissions.push(s);
      const orderId = `ALG9${String(++n).padStart(7, '0')}`;
      const reply: SubmitReply = options.reject === true ? { ok: false, code: 'INVALID_SUBMISSION', message: 'no' } : { ok: true, orderId, v: 1 };
      if (options.hold !== true) return Promise.resolve(reply);
      return new Promise((resolve) => waiting.push(() => resolve(reply)));
    },
  };
  const current = options.current ?? currentOrders();
  const rng = mulberry32(options.seed ?? 1);
  const sim = new Simulator({ rng, feed: quoteBookFor(current), reports: sink, preset: 'medium', current, startSeq: 100_000, runTag: 'run1' });
  return {
    sim,
    reports,
    submissions,
    answers,
    flush: async (): Promise<void> => {
      for (const release of waiting.splice(0)) release();
      await Promise.resolve();
    },
  };
}

const command = (orderId: string, action: OrderCommand['action'], n = 1): OrderCommand => ({ orderId, action, requestedBy: 'u', ts: SEED_NOW, commandId: `c:${n}` });
const recordOf = (order: Order, execSeq = 0, v = 2): OrderStateRecord => ({ v, execSeq, srcTs: 1, order });

describe('Simulator in reports mode', () => {
  it('needs somewhere to send what happens', () => {
    expect(() => new Simulator({ rng: mulberry32(1), feed: quoteBookFor([]), preset: 'medium', current: [], startSeq: 0 })).toThrow(/emit.*reports/);
  });

  it('reconciles stale orders as reports: LIVE past its end fills the remainder or is cancelled as expired, PENDING_START is activated', async () => {
    const r = rig();
    const before = currentOrders();
    const live = before.filter((o) => o.status === 'LIVE');
    r.sim.reconcile(LATER);
    await r.flush();
    const byOrder = (id: string): ExecReport[] => r.reports.filter((x) => x.orderId === id);
    for (const o of live) {
      const [first] = byOrder(o.orderId);
      expect(first?.type === 'FILL' || (first?.type === 'CANCELLED' && first.reason === 'EXPIRED')).toBe(true);
      if (first?.type === 'FILL') {
        expect(first.qty).toBe(o.remainingQty);
        expect(first.price).toBeGreaterThan(0);
        expect(first.ask).toBeGreaterThanOrEqual(first.bid);
      }
    }
    const pending = before.filter((o) => o.status === 'PENDING_START');
    for (const o of pending) expect(byOrder(o.orderId)[0]).toMatchObject({ type: 'ACTIVATED', execSeq: 1 });
    expect(r.reports.every((x) => x.ts === LATER)).toBe(true);
  });

  it('numbers the reports of each order from 1 and independently of the others', async () => {
    const r = rig();
    r.sim.reconcile(LATER);
    let t = LATER;
    for (let i = 0; i < 300; i++) {
      t += 100;
      r.sim.step(t, 100);
      await r.flush();
    }
    const seqs = new Map<string, number[]>();
    for (const x of r.reports) seqs.set(x.orderId, [...(seqs.get(x.orderId) ?? []), x.execSeq]);
    expect(seqs.size).toBeGreaterThan(50);
    for (const list of seqs.values()) expect(list).toEqual(list.map((_, i) => i + 1));
  });

  it('sends new orders as submissions with a unique clientOrderId and no id, and tracks each under the id it is given', async () => {
    const r = rig();
    r.sim.topUp(LATER);
    expect(r.submissions.length).toBeGreaterThan(400);
    expect(new Set(r.submissions.map((s) => s.clientOrderId)).size).toBe(r.submissions.length);
    for (const s of r.submissions.slice(0, 20)) {
      expect(s.clientOrderId).toMatch(/^run1-\d+$/);
      expect(s.order.clientOrderId).toBe(s.clientOrderId);
      expect('orderId' in s.order).toBe(false);
      expect(s.order.status).toBe('LIVE');
    }
    await r.flush();
    expect(r.sim.liveCount).toBeGreaterThanOrEqual(500);
    expect(r.sim.order('ALG90000001')?.clientOrderId).toBe(r.submissions[0]?.clientOrderId);
  });

  it('counts submissions that have not been answered yet, so a burst does not overshoot the preset', async () => {
    const r = rig({ current: [], hold: true });
    expect(r.sim.topUp(LATER)).toBe(500);
    expect(r.sim.topUp(LATER)).toBe(0);
    expect(r.sim.liveCount).toBe(0);
    await r.flush();
    expect(r.sim.liveCount).toBe(500);
  });

  it('does not track an order whose submission is refused, and frees its place', async () => {
    const r = rig({ current: [], reject: true });
    r.sim.topUp(LATER);
    await r.flush();
    expect(r.sim.liveCount).toBe(0);
    expect(r.sim.topUp(LATER)).toBe(500);
  });

  it('fills with a report that carries the quantity, the price and the quote', async () => {
    const r = rig();
    r.sim.topUp(LATER);
    await r.flush();
    r.reports.length = 0;
    let t = LATER;
    for (let i = 0; i < 20; i++) {
      t += 100;
      r.sim.step(t, 100);
    }
    const fills = r.reports.filter((x): x is Extract<ExecReport, { type: 'FILL' }> => x.type === 'FILL');
    expect(fills.length).toBeGreaterThan(100);
    for (const f of fills.slice(0, 50)) {
      expect(f.qty).toBeGreaterThan(0);
      expect(f.price).toBeGreaterThan(0);
      expect(f.bid).toBeLessThan(f.ask);
    }
  });

  it('keeps its own copy in step with what the order service computes from the same reports', async () => {
    const r = rig();
    r.sim.topUp(LATER);
    await r.flush();
    const initial = new Map<string, Order>();
    for (const [i, s] of r.submissions.entries()) initial.set(`ALG9${String(i + 1).padStart(7, '0')}`, { ...s.order, orderId: `ALG9${String(i + 1).padStart(7, '0')}` } as Order);
    let t = LATER;
    for (let i = 0; i < 400; i++) {
      t += 100;
      r.sim.step(t, 100);
      await r.flush();
    }
    // Replay the reports of a few orders through the order service's own rules and compare with the simulator's copy.
    let compared = 0;
    for (const [orderId, order] of initial) {
      const mine = r.reports.filter((x) => x.orderId === orderId);
      if (mine.length < 3) continue;
      let record: OrderStateRecord = { v: 1, execSeq: 0, srcTs: 0, order };
      for (const rep of mine) {
        const result = applyExecReport(record, rep);
        if (result.kind === 'applied') record = result.record;
      }
      const sim = r.sim.order(orderId);
      if (sim !== undefined) {
        expect(record.order.filledQty).toBe(sim.filledQty);
        expect(record.order.status).toBe(sim.status);
        expect(record.order.numFills).toBe(sim.numFills);
        compared++;
      }
      if (compared >= 25) break;
    }
    expect(compared).toBeGreaterThan(5);
  });

  it('answers a PAUSE: a PAUSED report that carries the command id, and an answer with the status', () => {
    const r = rig();
    const id = currentOrders().find((o) => o.status === 'LIVE')?.orderId as string;
    r.sim.command(command(id, 'PAUSE', 7), SEED_NOW);
    expect(r.reports).toEqual([{ type: 'PAUSED', orderId: id, execSeq: 1, instrId: 'c:7', ts: SEED_NOW }]);
    expect(r.answers).toEqual([{ type: 'UPDATE', order: { orderId: id, status: 'PAUSED' }, ts: SEED_NOW, commandId: 'c:7' }]);
    r.sim.command(command(id, 'RESUME', 8), SEED_NOW + 5_000);
    expect(r.reports[1]).toMatchObject({ type: 'RESUMED', execSeq: 2, instrId: 'c:8' });
    expect(r.answers[1]).toMatchObject({ order: { status: 'LIVE' }, commandId: 'c:8' });
  });

  it('answers a CANCEL with a CANCELLED report by the trader, with the quote', () => {
    const r = rig();
    const id = currentOrders().find((o) => o.status === 'LIVE')?.orderId as string;
    r.sim.command(command(id, 'CANCEL', 9), SEED_NOW);
    expect(r.reports[0]).toMatchObject({ type: 'CANCELLED', orderId: id, reason: 'TRADER', instrId: 'c:9' });
    expect((r.reports[0] as { bid: number }).bid).toBeGreaterThan(0);
    expect(r.sim.order(id)).toBeUndefined();
  });

  it('rejects a command it cannot carry out on the answer channel, and reports nothing', () => {
    const r = rig();
    const id = currentOrders().find((o) => o.status === 'LIVE')?.orderId as string;
    r.sim.command(command('NOPE', 'CANCEL', 1), SEED_NOW);
    r.sim.command(command(id, 'RESUME', 2), SEED_NOW);
    expect(r.answers).toMatchObject([
      { type: 'REJECT', code: 'UNKNOWN_ORDER', commandId: 'c:1' },
      { type: 'REJECT', code: 'INVALID_TRANSITION', commandId: 'c:2' },
    ]);
    expect(r.reports).toEqual([]);
  });
});

describe('Simulator.syncRecord', () => {
  it('adopts an open order it did not know, and carries on numbering above the record', () => {
    const r = rig({ current: [] });
    const order = { ...(currentOrders().find((o) => o.status === 'LIVE') as Order), endTime: LATER * 2 };
    r.sim.syncRecord(recordOf(order, 7));
    expect(r.sim.order(order.orderId)).toMatchObject({ orderId: order.orderId, status: 'LIVE' });
    expect(r.sim.liveCount).toBe(1);
    r.sim.command(command(order.orderId, 'PAUSE'), SEED_NOW);
    expect(r.reports[0]).toMatchObject({ execSeq: 8 });
  });

  it('takes up a changed record (an amend), but ignores one behind the reports already sent', () => {
    const r = rig({ current: [] });
    const order = { ...(currentOrders().find((o) => o.status === 'LIVE') as Order), endTime: LATER * 2 };
    r.sim.syncRecord(recordOf(order, 3));
    r.sim.syncRecord(recordOf({ ...order, orderQty: order.orderQty * 2 }, 3, 3));
    expect(r.sim.order(order.orderId)?.orderQty).toBe(order.orderQty * 2);
    r.sim.command(command(order.orderId, 'PAUSE'), SEED_NOW);
    expect(r.reports[0]).toMatchObject({ execSeq: 4 });
    r.sim.syncRecord(recordOf({ ...order, orderQty: 1 }, 3, 4));
    expect(r.sim.order(order.orderId)?.orderQty).toBe(order.orderQty * 2);
  });

  it('drops an order that has finished, and a later report for it starts again from nothing', () => {
    const r = rig({ current: [] });
    const order = currentOrders().find((o) => o.status === 'LIVE') as Order;
    r.sim.syncRecord(recordOf(order, 2));
    r.sim.syncRecord(recordOf({ ...order, status: 'FILLED' }, 5, 9));
    expect(r.sim.order(order.orderId)).toBeUndefined();
    expect(r.sim.liveCount).toBe(0);
  });
});
