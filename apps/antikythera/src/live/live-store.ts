import {
  OVERLAY_FIELDS,
  deriveOverlay,
  isOpen,
  type CurrencyPair,
  type Order,
  type OrderField,
  type OrderStateRecord,
  type OrderStatus,
  type PriceDerivationInput,
  type PriceTick,
} from '@apeiron/logos';
import { ChangeSet } from '../query/changeset.js';
import type { ColumnarStore } from '../store/columnar-store.js';
import { StatusCounters } from './counters.js';

export type LiveStoreLogger = { warn(obj: Record<string, unknown>, msg: string): void };

export type LiveStoreStats = {
  /** Records that changed or created a row. */
  recordsApplied: number;
  /** Records at or below the version a row already holds (a replay, or a rebuild of the projection). */
  recordsStale: number;
  ticksApplied: number;
  priceRecomputes: number;
  rowsAppended: number;
};

type Queued = { record: OrderStateRecord; revision: number };

const OVERLAY_SET: ReadonlySet<string> = new Set(OVERLAY_FIELDS);

const rowStatus = (store: ColumnarStore, row: number): OrderStatus => {
  const c = store.enumColumn('status');
  return c.dict.values[c.codes[row] as number] as OrderStatus;
};

/**
 * Applies the live feed to the store. Events and ticks are queued as they arrive and applied together at
 * flush time, so the store, the views and the clients all move in one synchronous step per tick:
 *
 * - order records (the full latest state of an order, from the order service) are written in place when their
 *   version is newer than the row's, feeding the tick's ChangeSet;
 * - the price join keeps `liveByPair` as statuses change and, for each pair that ticked, overlays the six
 *   price-derived fields on its LIVE and PAUSED rows with the shared logos function `deriveOverlay`. An overlay is a pure
 *   function of the record and the latest quote: it never touches `lastUpdateTime`, which only the order service sets;
 * - a record never regresses a row: it is applied only when its `v` is above the one the row holds.
 */
export class LiveStore {
  readonly counters = new StatusCounters();
  readonly stats: LiveStoreStats = { recordsApplied: 0, recordsStale: 0, ticksApplied: 0, priceRecomputes: 0, rowsAppended: 0 };
  private queue: Queued[] = [];
  private readonly latestTicks = new Map<CurrencyPair, PriceTick>();
  private pendingTicks = new Set<CurrencyPair>();
  private readonly liveByPair = new Map<CurrencyPair, Set<number>>();
  private flushAgeMs: number | null = null;
  private revision = 0;

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

  /** The highest key-value revision applied to the store (records from the initial load count as applied). */
  get appliedRevision(): number {
    return this.revision;
  }

  /** Records the highest revision the initial load saw. */
  noteRevision(revision: number): void {
    this.revision = Math.max(this.revision, revision);
  }

  /** The latest tick time per pair, for diagnostics. */
  lastTickTs(): Record<string, number> {
    return Object.fromEntries([...this.latestTicks].map(([pair, tick]) => [pair, tick.ts]));
  }

  /** How many pairs have a price. */
  get pairsWithPrice(): number {
    return this.latestTicks.size;
  }

  /** Age in ms of the oldest event or tick the last `flush` applied, or null when it applied none. */
  get lastFlushAgeMs(): number | null {
    return this.flushAgeMs;
  }

  get liveRows(): number {
    let n = 0;
    for (const s of this.liveByPair.values()) n += s.size;
    return n;
  }

  /** Queues a record for the next flush; `revision` is its key-value revision. */
  enqueueRecord(record: OrderStateRecord, revision: number): void {
    this.queue.push({ record, revision });
  }

  /** A tick older than the one already held for its pair (a replayed last value) is ignored. */
  enqueueTick(tick: PriceTick): void {
    const held = this.latestTicks.get(tick.pair);
    if (held !== undefined && held.ts > tick.ts) return;
    this.latestTicks.set(tick.pair, tick);
    this.pendingTicks.add(tick.pair);
  }

  /** Applies everything queued since the last flush and returns the tick's ChangeSet. */
  flush(now: number): ChangeSet {
    const cs = new ChangeSet();
    const queue = this.queue;
    this.queue = [];
    const eventRows = new Set<number>();
    let oldest = Infinity;
    for (const { record, revision } of queue) {
      oldest = Math.min(oldest, record.srcTs);
      this.applyRecord(record, cs, eventRows);
      this.revision = Math.max(this.revision, revision);
    }
    for (const pair of this.pendingTicks) oldest = Math.min(oldest, (this.latestTicks.get(pair) as PriceTick).ts);
    this.flushAgeMs = oldest === Infinity ? null : Math.max(0, now - oldest);
    this.applyPrices(cs, eventRows);
    return cs;
  }

  // ------------------------------------------------------------------ events

  private applyRecord(record: OrderStateRecord, cs: ChangeSet, eventRows: Set<number>): void {
    const { order } = record;
    const row = this.store.rowIndexOf(order.orderId);
    if (row === undefined) {
      this.store.appendBatch([order], [record.v]);
      const appended = this.store.size - 1;
      cs.noteNew(appended, record.srcTs);
      this.stats.recordsApplied++;
      this.stats.rowsAppended++;
      this.countRow(appended, 1);
      this.syncLive(appended, undefined);
      eventRows.add(appended);
      return;
    }
    if (record.v <= this.store.versionAt(row)) {
      this.stats.recordsStale++;
      return;
    }
    const { changed, prev } = this.store.updateRow(row, this.patchOf(order));
    this.store.setVersion(row, record.v);
    this.stats.recordsApplied++;
    this.afterUpdate(row, changed, prev, cs, record.srcTs);
    eventRows.add(row);
  }

  /**
   * What to write over a row. An open order whose pair has a price keeps its overlay fields (the repricing that
   * follows rewrites them from the tick), so a record carrying an older market snapshot never flickers them back.
   */
  private patchOf(order: Order): Partial<Order> {
    if (!isOpen(order.status) || !this.latestTicks.has(order.currencyPair)) return order;
    const patch: Record<string, unknown> = {};
    for (const key of Object.keys(order)) if (!OVERLAY_SET.has(key)) patch[key] = order[key as keyof Order];
    return patch as Partial<Order>;
  }

  private afterUpdate(row: number, changed: readonly OrderField[], prev: Partial<Order>, cs: ChangeSet, ts: number): void {
    if (changed.length === 0) return;
    const accounting = changed.some((f) => f === 'status' || f === 'notionalUsd' || f === 'traderId');
    if (accounting) this.countRow(row, -1, prev);
    cs.noteUpdate(row, changed, prev, ts);
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

  private applyPrices(cs: ChangeSet, eventRows: Set<number>): void {
    const ticked = this.pendingTicks;
    this.pendingTicks = new Set();
    for (const pair of ticked) {
      const tick = this.latestTicks.get(pair) as PriceTick;
      this.stats.ticksApplied++;
      const rows = this.liveByPair.get(pair);
      if (rows === undefined) continue;
      for (const row of rows) this.recompute(row, tick, cs, tick.ts);
    }
    // A fill changes unrealised P&L, so rows touched by records are repriced even if their pair is quiet.
    for (const row of eventRows) {
      if (!isOpen(rowStatus(this.store, row))) continue;
      const pair = this.pairOf(row);
      if (ticked.has(pair)) continue;
      const tick = this.latestTicks.get(pair);
      if (tick !== undefined) this.recompute(row, tick, cs, Infinity);
    }
  }

  /** `ts` is the source timestamp this repricing is owed to: the tick's own, or Infinity when an order event already supplied it. */
  private recompute(row: number, tick: PriceTick, cs: ChangeSet, ts: number): void {
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
    const { changed, prev } = s.updateRow(row, deriveOverlay(input, tick));
    this.stats.priceRecomputes++;
    cs.noteUpdate(row, changed, prev, ts);
  }
}
