import {
  OrderFactory,
  PAIR_BY_NAME,
  applyCommand,
  applyFill,
  isTerminal,
  normal,
  sideSign,
  transition,
  uniform,
  type LoadPreset,
  type ExecReport,
  type OrderCommand,
  type Order,
  type OrderEvent,
  type OrderStateRecord,
  type Rng,
  type Submission,
  type SubmitReply,
} from '@apeiron/logos';
import type { Quotes } from './quotes.js';
import { LOAD_PRESETS, type PresetRates } from './presets.js';

const MIN_MS = 60_000;
/** Chance that a lifecycle step cancels the order instead of filling it ("expiry cancel"). */
export const EXPIRY_CANCEL_PROBABILITY = 0.005;
/** Share of orders that end CANCELLED when their end time passes with quantity left. */
export const END_CANCEL_PROBABILITY = 0.08;
/** Share of new orders that start LIVE rather than PENDING_START. */
export const NEW_LIVE_SHARE = 0.8;

/**
 * Where the simulator sends what happens at the venue in `reports` mode: execution reports (it numbers them per order),
 * new orders as submissions to the order service, and the answers to commands it was sent on `orders.commands`.
 */
export type ReportSink = {
  report(report: ExecReport): void;
  submit(submission: Submission): Promise<SubmitReply>;
  answer(answer: OrderEvent): void;
};

export type SimulatorOptions = {
  rng: Rng;
  /** The market now, from the price feed's ticks. */
  feed: Quotes;
  /** Where what happens at the venue goes: reports, submissions and command answers. */
  reports: ReportSink;
  /** Makes the `clientOrderId` of each submission unique to this run (default: random). */
  runTag?: string;
  preset: LoadPreset;
};

/** What a change to an order is, as a report to the order service. */
export type ReportSpec =
  | { type: 'ACTIVATED' }
  | { type: 'FILL' }
  | { type: 'CANCELLED'; reason: 'TRADER' | 'EXPIRED' }
  | { type: 'PAUSED' }
  | { type: 'RESUMED' };

export type StepStats = { fills: number; statusChanges: number; created: number };

const roundTo = (value: number, decimals: number): number => {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
};

/** Index-addressable set with O(1) add, remove and uniform random pick. */
class Pool {
  private readonly ids: string[] = [];
  private readonly index = new Map<string, number>();

  get size(): number {
    return this.ids.length;
  }

  has(id: string): boolean {
    return this.index.has(id);
  }

  add(id: string): void {
    if (this.index.has(id)) return;
    this.index.set(id, this.ids.length);
    this.ids.push(id);
  }

  delete(id: string): void {
    const i = this.index.get(id);
    if (i === undefined) return;
    const last = this.ids.pop() as string;
    this.index.delete(id);
    if (i < this.ids.length) {
      this.ids[i] = last;
      this.index.set(last, i);
    }
  }

  pick(rng: Rng): string | undefined {
    return this.ids[Math.floor(rng() * this.ids.length)];
  }

  snapshot(): string[] {
    return [...this.ids];
  }
}

/**
 * The mock order lifecycle (Appendix E). Holds the orders that can still change, and on each `step`
 * activates PENDING_START orders at their start time, completes LIVE orders at their end time, produces
 * fills at the preset rate, and creates new orders. Everything it emits carries absolute values.
 * Deterministic for a given `rng`, feed and clock.
 */
export class Simulator {
  private readonly orders = new Map<string, Order>();
  private readonly live = new Pool();
  private readonly pending = new Pool();
  private readonly factory: OrderFactory;
  private rates: PresetRates;
  private presetName: LoadPreset;
  private readonly execSeqs = new Map<string, number>();
  private readonly inflight = { LIVE: 0, PENDING_START: 0 };
  private readonly runTag: string;
  private submitted = 0;
  private fillCarry = 0;
  private newCarry = 0;
  private emitted = 0;

  constructor(private readonly options: SimulatorOptions) {
    this.presetName = options.preset;
    this.rates = LOAD_PRESETS[options.preset];
    this.factory = new OrderFactory(options.rng);
    this.runTag = options.runTag ?? Math.random().toString(36).slice(2, 10);
  }

  get preset(): LoadPreset {
    return this.presetName;
  }

  get liveCount(): number {
    return this.live.size;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** LIVE orders, counting those whose submission the order service has not answered yet. */
  private get liveTotal(): number {
    return this.live.size + this.inflight.LIVE;
  }

  private get pendingTotal(): number {
    return this.pending.size + this.inflight.PENDING_START;
  }

  get eventsEmitted(): number {
    return this.emitted;
  }

  /** The order as the simulator last saw it. */
  order(orderId: string): Order | undefined {
    return this.orders.get(orderId);
  }

  /** Switches the rates and tops LIVE up to the new target. */
  setPreset(preset: LoadPreset, now: number): void {
    this.presetName = preset;
    this.rates = LOAD_PRESETS[preset];
    this.topUp(now);
  }

  /**
   * Startup reconciliation: current orders are anchored to the seed time and stale on a later day. LIVE
   * orders past their end become FILLED (or CANCELLED with probability 0.08), PENDING_START orders past
   * their start become LIVE, then LIVE is topped up to the preset target. All published as ordinary events.
   */
  reconcile(now: number): StepStats {
    const stats: StepStats = { fills: 0, statusChanges: 0, created: 0 };
    this.activateDue(now, stats);
    this.completeDue(now, stats);
    stats.created += this.topUp(now);
    return stats;
  }

  /** Advances the simulation to `now`; `dtMs` is the time since the previous step and sets how many events fall due. */
  step(now: number, dtMs: number): StepStats {
    const stats: StepStats = { fills: 0, statusChanges: 0, created: 0 };
    this.activateDue(now, stats);
    this.completeDue(now, stats);

    this.fillCarry += (this.rates.updatesPerSec * dtMs) / 1000;
    const fills = Math.floor(this.fillCarry);
    this.fillCarry -= fills;
    for (let i = 0; i < fills; i++) this.fillOne(now, stats);

    this.newCarry += (this.rates.newOrdersPerSec * dtMs) / 1000;
    const created = Math.floor(this.newCarry);
    this.newCarry -= created;
    for (let i = 0; i < created; i++) {
      const startsLive = this.liveTotal < this.rates.liveMin || this.options.rng() < NEW_LIVE_SHARE;
      if (startsLive && this.liveTotal < this.rates.liveCap) {
        this.create('LIVE', now);
        stats.created++;
      } else if (this.pendingTotal < this.rates.pendingCap) {
        this.create('PENDING_START', now);
        stats.created++;
      }
    }
    return stats;
  }

  /** Creates LIVE orders until the preset's target is reached. Returns how many were created. */
  topUp(now: number): number {
    let created = 0;
    while (this.liveTotal < this.rates.liveTarget) {
      this.create('LIVE', now);
      created++;
    }
    return created;
  }

  /**
   * Applies a trader command to an order the simulator holds: the change goes out as an execution report and the answer
   * as an UPDATE carrying the command's id and the new status, or a REJECT (INVALID_TRANSITION from the lifecycle
   * rules, UNKNOWN_ORDER for an order that is not held, such as a historical one).
   */
  command(command: OrderCommand, now: number): void {
    const order = this.orders.get(command.orderId);
    if (order === undefined) {
      this.reply({
        type: 'REJECT',
        commandId: command.commandId,
        orderId: command.orderId,
        code: 'UNKNOWN_ORDER',
        message: `Order ${command.orderId} is not active`,
        ts: now,
      });
      return;
    }
    const result = applyCommand(order, command.action, now);
    if (!result.ok) {
      this.reply({
        type: 'REJECT',
        commandId: command.commandId,
        orderId: command.orderId,
        code: result.code,
        message: result.message,
        ts: now,
      });
      return;
    }
    // Time spent paused does not count against the order: resuming pushes its end time out by that long, so a
    // resumed order carries on filling instead of being completed on the spot. `lastUpdateTime` is when it paused.
    const changes: Partial<Order> =
      command.action === 'RESUME'
        ? { ...result.changes, endTime: order.endTime + Math.max(0, now - order.lastUpdateTime) }
        : result.changes;
    const report: ReportSpec =
      command.action === 'CANCEL' ? { type: 'CANCELLED', reason: 'TRADER' } : command.action === 'PAUSE' ? { type: 'PAUSED' } : { type: 'RESUMED' };
    this.commit(order, changes, now, report, command.commandId);
  }

  /**
   * Brings an order the simulator holds in line with the order service's latest record of it (`reports` mode): after a
   * restart, for an order submitted elsewhere, or when the order service changed its parameters. A record that is behind
   * the reports this simulator has already sent for the order (a lower `execSeq`) is ignored, and a finished order is dropped.
   */
  syncRecord(record: OrderStateRecord): void {
    const id = record.order.orderId;
    const mine = this.execSeqs.get(id);
    if (mine !== undefined && record.execSeq < mine) return;
    if (isTerminal(record.order.status)) {
      this.orders.delete(id);
      this.live.delete(id);
      this.pending.delete(id);
      this.execSeqs.delete(id);
      return;
    }
    this.execSeqs.set(id, Math.max(mine ?? 0, record.execSeq));
    this.track({ ...record.order });
  }

  /** Answers a command on the report sink's answer channel. */
  private reply(event: OrderEvent): void {
    this.emitted++;
    this.options.reports.answer(event);
  }

  private nextExecSeq(orderId: string): number {
    const n = (this.execSeqs.get(orderId) ?? 0) + 1;
    this.execSeqs.set(orderId, n);
    return n;
  }

  private track(order: Order): void {
    this.orders.set(order.orderId, order);
    this.live.delete(order.orderId);
    this.pending.delete(order.orderId);
    if (order.status === 'LIVE') this.live.add(order.orderId);
    else if (order.status === 'PENDING_START') this.pending.add(order.orderId);
    else if (order.status !== 'PAUSED') this.orders.delete(order.orderId);
  }

  /**
   * Applies a change to the simulator's own copy of the order and reports it to the order service: an execution report
   * numbered per order, with the quote for a fill or a cancel. The order service applies it with the same rules and
   * computes the market snapshot and the realised P&L from that quote. A command's answer goes out as well.
   */
  private commit(order: Order, changes: Partial<Order>, now: number, report: ReportSpec, commandId?: string): Order {
    const sink = this.options.reports;
    const next = { ...order, ...changes };
    this.track(next);
    const base = { orderId: order.orderId, execSeq: this.nextExecSeq(order.orderId), ts: now };
    const quote = (): { bid: number; ask: number } => {
      const q = this.options.feed.quote(order.currencyPair);
      const mid = this.options.feed.mid(order.currencyPair);
      return { bid: q?.bid ?? mid, ask: q?.ask ?? mid };
    };
    let out: ExecReport;
    switch (report.type) {
      case 'ACTIVATED':
        out = { type: 'ACTIVATED', ...base };
        break;
      case 'FILL':
        out = { type: 'FILL', ...base, qty: next.lastFillQty, price: next.lastFillPrice as number, ...quote() };
        break;
      case 'CANCELLED':
        out = { type: 'CANCELLED', ...base, ...(commandId === undefined ? {} : { instrId: commandId }), reason: report.reason, ...quote() };
        break;
      default:
        out = { type: report.type, ...base, instrId: commandId ?? 'venue' };
    }
    this.emitted++;
    sink.report(out);
    if (commandId !== undefined) {
      sink.answer({ type: 'UPDATE', order: { orderId: order.orderId, status: next.status }, ts: now, commandId });
    }
    return next;
  }

  private activateDue(now: number, stats: StepStats): void {
    for (const id of this.pending.snapshot()) {
      const order = this.orders.get(id);
      if (order === undefined || order.startTime > now) continue;
      const result = transition(order, 'LIVE', now);
      if (result.ok) {
        this.commit(order, result.changes, now, { type: 'ACTIVATED' });
        stats.statusChanges++;
      }
    }
  }

  private completeDue(now: number, stats: StepStats): void {
    for (const id of this.live.snapshot()) {
      const order = this.orders.get(id);
      if (order === undefined || order.endTime > now) continue;
      this.complete(order, now);
      stats.statusChanges++;
    }
  }

  /** End of an order's life: filled with whatever remains (92%), or cancelled (8%). */
  private complete(order: Order, now: number): void {
    if (this.options.rng() < END_CANCEL_PROBABILITY) {
      this.cancel(order, now);
      return;
    }
    const changes = applyFill(this.priced(order), order.remainingQty, this.fillPrice(order), now);
    if (changes.status === undefined) {
      this.cancel(order, now);
      return;
    }
    this.commit(order, changes, now, { type: 'FILL' });
  }

  private cancel(order: Order, now: number): void {
    const result = transition(order, 'CANCELLED', now);
    if (result.ok) this.commit(order, result.changes, now, { type: 'CANCELLED', reason: 'EXPIRED' });
  }

  private fillOne(now: number, stats: StepStats): void {
    const id = this.live.pick(this.options.rng);
    if (id === undefined) return;
    const order = this.orders.get(id);
    if (order === undefined) return;
    if (this.options.rng() < EXPIRY_CANCEL_PROBABILITY) {
      this.cancel(order, now);
      stats.statusChanges++;
      return;
    }
    const base = order.orderQty / this.rates.fillsPerOrder;
    const qty = Math.max(1_000, Math.round((base * uniform(this.options.rng, 0.7, 1.3)) / 1_000) * 1_000);
    const changes = applyFill(this.priced(order), qty, this.fillPrice(order), now);
    if (Object.keys(changes).length === 0) return;
    this.commit(order, changes, now, { type: 'FILL' });
    stats.fills++;
  }

  /** The order with `marketMid` set from the feed, which realised P&L on completion is measured against. */
  private priced(order: Order): Order {
    const dec = (PAIR_BY_NAME.get(order.currencyPair) as { decimals: number }).decimals;
    return { ...order, marketMid: roundTo(this.options.feed.mid(order.currencyPair), dec) };
  }

  /** The current mid, moved against the order by a small random slippage (about 0.4bps on average). */
  private fillPrice(order: Order): number {
    const dec = (PAIR_BY_NAME.get(order.currencyPair) as { decimals: number }).decimals;
    const mid = this.options.feed.mid(order.currencyPair);
    return roundTo(mid * (1 + (sideSign(order.side) * normal(this.options.rng, 0.4, 1.5)) / 1e4), dec);
  }

  private create(status: 'LIVE' | 'PENDING_START', now: number): void {
    for (const [pair, mid] of Object.entries(this.currentMids())) this.factory.mids.set(pair as Order['currencyPair'], mid);
    const rng = this.options.rng;
    // 1-2 minutes: arrivals x lifetime is about 450 LIVE on medium and 4,500 on stress, inside each band.
    const durationMins = 1 + Math.floor(rng() * 2);
    const startTime = status === 'LIVE' ? now : now + Math.round(uniform(rng, 10_000, 2 * MIN_MS));
    const order = this.factory.create({
      status,
      createdAt: now,
      startTime,
      durationMins,
      fillFraction: 0,
      completedAt: null,
      now,
      current: true,
    });
    this.submitNew(order, status);
  }

  /**
   * `reports` mode: the order service owns ids and creation, so the order is sent as a submission and only tracked once
   * the reply gives its id. Until then it counts towards the LIVE and PENDING_START totals, so a burst of creations does
   * not overshoot the preset.
   */
  private submitNew(order: Order, status: 'LIVE' | 'PENDING_START'): void {
    const sink = this.options.reports;
    const key = `${this.runTag}-${++this.submitted}`;
    const { orderId: _provisional, ...rest } = order;
    this.inflight[status]++;
    this.emitted++;
    sink.submit({ clientOrderId: key, order: { ...rest, clientOrderId: key } }).then(
      (reply) => {
        this.inflight[status]--;
        if (!reply.ok) return;
        this.execSeqs.set(reply.orderId, 0);
        this.track({ ...order, orderId: reply.orderId, clientOrderId: key });
      },
      () => {
        this.inflight[status]--;
      },
    );
  }

  private currentMids(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const pair of PAIR_BY_NAME.keys()) out[pair] = this.options.feed.mid(pair);
    return out;
  }
}
