import {
  derivePriceFields,
  isOpen,
  type CurrencyPair,
  type Order,
  type OrderEvent,
  type OrderField,
  type OrderStatus,
  type PriceDerivationInput,
  type PriceTick,
} from '@apeiron/logos';
import { ChangeSet } from '../query/changeset.js';
import type { ColumnarStore } from '../store/columnar-store.js';
import { StatusCounters } from './counters.js';

export type LiveStoreLogger = { warn(obj: Record<string, unknown>, msg: string): void };

export type LiveStoreStats = {
  eventsApplied: number;
  ticksApplied: number;
  priceRecomputes: number;
  unknownOrders: number;
  rowsAppended: number;
};

type Queued = { event: OrderEvent; ack: () => void };

/** What a write-behind pass has to persist, and the acknowledgement to send once it has. */
export type WriteBatch = { orders: Order[]; ack: (() => void) | null };

const rowStatus = (store: ColumnarStore, row: number): OrderStatus => {
  const c = store.enumColumn('status');
  return c.dict.values[c.codes[row] as number] as OrderStatus;
};

/**
 * Applies the live feed to the store. Events and ticks are queued as they arrive and applied together at
 * flush time, so the store, the views and the clients all move in one synchronous step per tick:
 *
 * - order events (absolute values) are upserted in place, feeding the tick's ChangeSet;
 * - the price join keeps `liveByPair` as statuses change and, for each pair that ticked, recomputes the
 *   price-derived fields of its LIVE and PAUSED rows with the shared logos function (price-only changes are
 *   never persisted);
 * - rows touched by lifecycle events are remembered for write-behind, with the acknowledgement owed to the bus.
 */
export class LiveStore {
  readonly counters = new StatusCounters();
  readonly stats: LiveStoreStats = { eventsApplied: 0, ticksApplied: 0, priceRecomputes: 0, unknownOrders: 0, rowsAppended: 0 };
  private queue: Queued[] = [];
  private readonly latestTicks = new Map<CurrencyPair, PriceTick>();
  private pendingTicks = new Set<CurrencyPair>();
  private readonly liveByPair = new Map<CurrencyPair, Set<number>>();
  private dirty = new Set<string>();
  private lastAck: (() => void) | null = null;

  constructor(
    private readonly store: ColumnarStore,
    private readonly log: LiveStoreLogger,
  ) {}

  /** Scans the loaded store to build the status counters and the live-by-pair index. */
  init(): void {
    this.counters.clear();
    this.liveByPair.clear();
    const traders = this.store.enumColumn('traderId');
    const notional = this.store.numberColumn('notionalUsd');
    const pairs = this.store.enumColumn('currencyPair');
    for (let row = 0; row < this.store.size; row++) {
      const status = rowStatus(this.store, row);
      this.counters.apply(traders.dict.values[traders.codes[row] as number] as string, status, notional[row] as number, 1);
      if (isOpen(status)) this.trackLive(pairs.dict.values[pairs.codes[row] as number] as CurrencyPair, row, true);
    }
  }

  /** The status of an order in the store, or undefined when the store does not hold it. */
  statusOf(orderId: string): OrderStatus | undefined {
    const row = this.store.rowIndexOf(orderId);
    return row === undefined ? undefined : rowStatus(this.store, row);
  }

  get pendingEvents(): number {
    return this.queue.length;
  }

  get liveRows(): number {
    let n = 0;
    for (const s of this.liveByPair.values()) n += s.size;
    return n;
  }

  /** `ack` is called (through write-behind) once the event's effect has been persisted. */
  enqueueEvent(event: OrderEvent, ack: () => void): void {
    this.queue.push({ event, ack });
  }

  enqueueTick(tick: PriceTick): void {
    this.latestTicks.set(tick.pair, tick);
    this.pendingTicks.add(tick.pair);
  }

  /** Applies everything queued since the last flush and returns the tick's ChangeSet. */
  flush(now: number): ChangeSet {
    const cs = new ChangeSet();
    const queue = this.queue;
    this.queue = [];
    const eventRows = new Set<number>();
    for (const { event, ack } of queue) {
      this.applyEvent(event, cs, eventRows);
      this.lastAck = ack;
    }
    this.applyPrices(now, cs, eventRows);
    return cs;
  }

  /** Orders changed by lifecycle events since the last call (built from the store as it is now), plus the ack to send after persisting. */
  takeWriteBatch(): WriteBatch {
    const orders: Order[] = [];
    for (const id of this.dirty) {
      const row = this.store.rowIndexOf(id);
      if (row !== undefined) orders.push(this.store.orderAt(row));
    }
    const batch = { orders, ack: this.lastAck };
    this.dirty = new Set();
    this.lastAck = null;
    return batch;
  }

  /** Puts a failed batch back so the next pass retries it. */
  restoreWriteBatch(batch: WriteBatch): void {
    for (const o of batch.orders) this.dirty.add(o.orderId);
    this.lastAck ??= batch.ack;
  }

  // ------------------------------------------------------------------ events

  private applyEvent(event: OrderEvent, cs: ChangeSet, eventRows: Set<number>): void {
    if (event.type === 'REJECT') return;
    this.stats.eventsApplied++;
    if (event.type === 'NEW') {
      const result = this.store.upsert(event.order);
      if (result.kind === 'append') {
        cs.noteNew(result.row);
        this.stats.rowsAppended++;
        this.countRow(result.row, 1);
        this.syncLive(result.row, undefined);
      } else {
        this.afterUpdate(result.row, result.changed, result.prev, cs);
      }
      this.dirty.add(event.order.orderId);
      eventRows.add(result.row);
      return;
    }
    const row = this.store.rowIndexOf(event.order.orderId);
    if (row === undefined) {
      this.stats.unknownOrders++;
      if (this.stats.unknownOrders === 1 || this.stats.unknownOrders % 1000 === 0) {
        this.log.warn({ orderId: event.order.orderId, unknown: this.stats.unknownOrders }, 'event for an order not in the store');
      }
      return;
    }
    const { changed, prev } = this.store.updateRow(row, event.order);
    this.afterUpdate(row, changed, prev, cs);
    if (changed.length > 0) this.dirty.add(event.order.orderId);
    eventRows.add(row);
  }

  private afterUpdate(row: number, changed: readonly OrderField[], prev: Partial<Order>, cs: ChangeSet): void {
    if (changed.length === 0) return;
    const accounting = changed.some((f) => f === 'status' || f === 'notionalUsd' || f === 'traderId');
    if (accounting) this.countRow(row, -1, prev);
    cs.noteUpdate(row, changed, prev);
    if (accounting) this.countRow(row, 1);
    if (changed.includes('status') || changed.includes('currencyPair')) this.syncLive(row, prev);
  }

  /** Adds or removes a row's contribution to the status counters; `prev` substitutes old values. */
  private countRow(row: number, sign: 1 | -1, prev?: Partial<Order>): void {
    const traders = this.store.enumColumn('traderId');
    const trader = prev?.traderId ?? (traders.dict.values[traders.codes[row] as number] as string);
    const status = prev?.status ?? rowStatus(this.store, row);
    const notional = prev?.notionalUsd ?? (this.store.numberColumn('notionalUsd')[row] as number);
    this.counters.apply(trader, status, notional, sign);
  }

  private pairOf(row: number): CurrencyPair {
    const c = this.store.enumColumn('currencyPair');
    return c.dict.values[c.codes[row] as number] as CurrencyPair;
  }

  /** Keeps `liveByPair` in step with a row's status (and pair, though pairs never change in practice). */
  private syncLive(row: number, prev: Partial<Order> | undefined): void {
    const pair = this.pairOf(row);
    if (prev?.currencyPair !== undefined) this.trackLive(prev.currencyPair, row, false);
    this.trackLive(pair, row, isOpen(rowStatus(this.store, row)));
  }

  private trackLive(pair: CurrencyPair, row: number, live: boolean): void {
    let set = this.liveByPair.get(pair);
    if (live) {
      if (set === undefined) {
        set = new Set();
        this.liveByPair.set(pair, set);
      }
      set.add(row);
    } else {
      set?.delete(row);
    }
  }

  // ------------------------------------------------------------------ price join

  private applyPrices(now: number, cs: ChangeSet, eventRows: Set<number>): void {
    const ticked = this.pendingTicks;
    this.pendingTicks = new Set();
    for (const pair of ticked) {
      const tick = this.latestTicks.get(pair) as PriceTick;
      this.stats.ticksApplied++;
      const rows = this.liveByPair.get(pair);
      if (rows === undefined) continue;
      for (const row of rows) this.recompute(row, tick, now, cs);
    }
    // A fill changes unrealised P&L and slippage, so rows touched by events are repriced even if their pair is quiet.
    for (const row of eventRows) {
      if (!isOpen(rowStatus(this.store, row))) continue;
      const pair = this.pairOf(row);
      if (ticked.has(pair)) continue;
      const tick = this.latestTicks.get(pair);
      if (tick !== undefined) this.recompute(row, tick, now, cs);
    }
  }

  private recompute(row: number, tick: PriceTick, now: number, cs: ChangeSet): void {
    const s = this.store;
    const n = (field: OrderField): number => s.numberColumn(field)[row] as number;
    const orNull = (v: number): number | null => (v === v ? v : null);
    const side = s.enumColumn('side');
    const input: PriceDerivationInput = {
      currencyPair: tick.pair,
      side: side.dict.values[side.codes[row] as number] as PriceDerivationInput['side'],
      status: rowStatus(s, row),
      limitPrice: orNull(n('limitPrice')),
      avgFillPrice: orNull(n('avgFillPrice')),
      arrivalPrice: n('arrivalPrice'),
      filledQty: n('filledQty'),
      orderQty: n('orderQty'),
      notionalUsd: n('notionalUsd'),
    };
    const { changed, prev } = s.updateRow(row, derivePriceFields(input, tick, now));
    this.stats.priceRecomputes++;
    cs.noteUpdate(row, changed, prev);
  }
}
