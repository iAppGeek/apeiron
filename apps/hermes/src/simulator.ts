import {
  OrderFactory,
  PAIR_BY_NAME,
  applyFill,
  normal,
  parseOrderSeq,
  sideSign,
  transition,
  uniform,
  type LoadPreset,
  type Order,
  type OrderEvent,
  type Rng,
} from '@apeiron/logos';
import type { PriceFeed } from './price-feed.js';
import { LOAD_PRESETS, type PresetRates } from './presets.js';

const MIN_MS = 60_000;
/** Chance that a lifecycle step cancels the order instead of filling it ("expiry cancel"). */
export const EXPIRY_CANCEL_PROBABILITY = 0.005;
/** Share of orders that end CANCELLED when their end time passes with quantity left. */
export const END_CANCEL_PROBABILITY = 0.08;
/** Share of new orders that start LIVE rather than PENDING_START. */
export const NEW_LIVE_SHARE = 0.8;

export type SimulatorOptions = {
  rng: Rng;
  feed: PriceFeed;
  /** Receives every `orders.events` message the simulator produces. */
  emit: (event: OrderEvent) => void;
  preset: LoadPreset;
  /** The LIVE, PAUSED and PENDING_START orders at startup (`loadCurrent()`). */
  current: readonly Order[];
  /** Highest order sequence number issued so far (from `maxOrderId()`); new ids continue above it. */
  startSeq: number;
};

export type StepStats = { fills: number; statusChanges: number; created: number };

const roundTo = (value: number, decimals: number): number => {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
};

/** The sequence number to continue from, given the highest stored order id. */
export function nextSeqFrom(maxOrderId: string | null): number {
  if (maxOrderId === null) return 0;
  const seq = parseOrderSeq(maxOrderId);
  if (seq === null) throw new Error(`maxOrderId is not in the ALG + 8 digit format: ${maxOrderId}`);
  return seq;
}

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
  private fillCarry = 0;
  private newCarry = 0;
  private emitted = 0;

  constructor(private readonly options: SimulatorOptions) {
    this.presetName = options.preset;
    this.rates = LOAD_PRESETS[options.preset];
    this.factory = new OrderFactory(options.rng);
    this.factory.seq = options.startSeq;
    for (const order of options.current) this.track(order);
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
      const startsLive = this.live.size < this.rates.liveMin || this.options.rng() < NEW_LIVE_SHARE;
      if (startsLive && this.live.size < this.rates.liveCap) {
        this.create('LIVE', now);
        stats.created++;
      } else if (this.pending.size < this.rates.pendingCap) {
        this.create('PENDING_START', now);
        stats.created++;
      }
    }
    return stats;
  }

  /** Creates LIVE orders until the preset's target is reached. Returns how many were created. */
  topUp(now: number): number {
    let created = 0;
    while (this.live.size < this.rates.liveTarget) {
      this.create('LIVE', now);
      created++;
    }
    return created;
  }

  private emit(event: OrderEvent): void {
    this.emitted++;
    this.options.emit(event);
  }

  private track(order: Order): void {
    this.orders.set(order.orderId, order);
    this.live.delete(order.orderId);
    this.pending.delete(order.orderId);
    if (order.status === 'LIVE') this.live.add(order.orderId);
    else if (order.status === 'PENDING_START') this.pending.add(order.orderId);
    else if (order.status !== 'PAUSED') this.orders.delete(order.orderId);
  }

  private commit(order: Order, changes: Partial<Order>, now: number): Order {
    const next = { ...order, ...changes };
    this.track(next);
    this.emit({ type: 'UPDATE', order: { orderId: order.orderId, ...changes }, ts: now });
    return next;
  }

  private activateDue(now: number, stats: StepStats): void {
    for (const id of this.pending.snapshot()) {
      const order = this.orders.get(id);
      if (order === undefined || order.startTime > now) continue;
      const result = transition(order, 'LIVE', now);
      if (result.ok) {
        this.commit(order, result.changes, now);
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
    this.commit(order, changes, now);
  }

  private cancel(order: Order, now: number): void {
    const result = transition(order, 'CANCELLED', now);
    if (result.ok) this.commit(order, result.changes, now);
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
    const base = order.orderQty / (Math.max(1, order.durationMins) * 6);
    const qty = Math.max(1_000, Math.round((base * uniform(this.options.rng, 0.7, 1.3)) / 1_000) * 1_000);
    const changes = applyFill(this.priced(order), qty, this.fillPrice(order), now);
    if (Object.keys(changes).length === 0) return;
    this.commit(order, changes, now);
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
    const durationMins = 1 + Math.floor(rng() * 4);
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
    this.track(order);
    this.emit({ type: 'NEW', order, ts: now });
  }

  private currentMids(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const pair of PAIR_BY_NAME.keys()) out[pair] = this.options.feed.mid(pair);
    return out;
  }
}
