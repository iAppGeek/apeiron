import { COLUMN_BY_FIELD, type OrderField, type Row, type SsrmRequest } from '@apeiron/logos';
import type { ColumnarStore } from '../store/columnar-store.js';
import { ChangeSet } from './changeset.js';
import { fail, ok, type Result } from './errors.js';
import { TRADER_ALL } from './filter.js';
import { normalizeRequest, type NormalizedQuery } from './request.js';
import { RowBuf } from './row-buf.js';
import { ViewCache, type ViewCacheOptions, type ViewCacheStats } from './view-cache.js';
import { STRUCTURAL_REBUILD_THRESHOLD, View, routeKeyOf, type ViewChanges } from './view.js';

export const SET_FILTER_VALUE_CAP = 5_000;

/** A view behind by more rows than this many times its rebuild threshold is rebuilt rather than patched. */
const CARRY_REBUILD_FACTOR = 4;

type LoggedTick = { seq: number; cs: ChangeSet; grown: ReadonlySet<OrderField> };

export type EngineOptions = ViewCacheOptions & {
  /** Largest `endRow - startRow` a client may request. */
  maxBlockRows: number;
  /** Structural changes in one tick above which a view is rebuilt instead of patched (default 5,000). */
  structuralRebuildThreshold?: number;
  /**
   * Keep patching views that no client tracks (default false: they are marked stale and rebuilt on their next
   * request). Tests that build views without tracking them turn this on.
   */
  patchUnsubscribed?: boolean;
  /**
   * Mark a view `rebuildPending` instead of rebuilding it inside `applyChanges` when a tick has more structural
   * changes than the threshold (default true; the caller then runs `takeRebuild` / `rebuildView`).
   */
  deferRebuilds?: boolean;
  /** Least time between deferred rebuilds of one view, in ms (default 1,000). */
  rebuildIntervalMs?: number;
};

/** What the last `applyChanges` did with the cached views. */
export type ApplyStats = { patched: number; deferred: number; unsubscribed: number; pendingRebuild: number; stale: number };

/** What a `getRows` handed back, for the per-client block tracking behind live deltas. */
export type TrackedBlock = {
  view: View;
  route: string[];
  routeKey: string;
  startRow: number;
  kind: 'leaf' | 'group';
  /** Row indexes of the leaf rows returned. */
  rowIdx: number[];
  /** Group keys of the group rows returned. */
  labels: string[];
};

export type RowsResult = {
  rows: Row[];
  /** Exact number of rows at the requested level. */
  rowCount: number;
  /** Server processing time for this request. */
  ms: number;
  /** True when the request had to build its view (a cold request). */
  built: boolean;
  track: TrackedBlock;
};

export type EngineStats = { cache: ViewCacheStats; lastApply: ApplyStats; rebuilds: number };

/**
 * Serves SSRM block requests and set-filter value lists from the columnar store. Not tied to any
 * transport: the WebSocket layer only validates frames and calls this.
 */
export class QueryEngine {
  private readonly cache: ViewCache;
  private readonly filterValueCache = new Map<string, string[]>();
  /** The shared 0..n-1 array that views with no filter use as their root. Only ever appended to. */
  private readonly identity = RowBuf.empty();
  private lastApply: ApplyStats = { patched: 0, deferred: 0, unsubscribed: 0, pendingRebuild: 0, stale: 0 };
  private rebuildCount = 0;
  private seq = 0;
  private log: LoggedTick[] = [];
  private behind = 0;

  constructor(
    private readonly store: ColumnarStore,
    private readonly options: EngineOptions,
  ) {
    this.cache = new ViewCache(options);
    this.syncIdentity();
    store.takeDictionaryGrowth();
  }

  getRows(traderId: string, req: SsrmRequest): Result<RowsResult> {
    const t0 = performance.now();
    const query = normalizeRequest(traderId, req, this.options);
    if (!query.ok) return query;
    const q = query.value;

    let view = this.cache.get(q.viewKey);
    const built = view === undefined || view.stale;
    if (view === undefined) {
      view = this.buildView(q);
      this.cache.set(q.viewKey, view);
    } else if (view.stale) {
      this.syncIdentity();
      view.rebuild();
      view.appliedSeq = this.seq;
    }
    const block = view.getBlock(q.groupKeys, q.startRow, q.endRow);
    this.cache.rebalance(q.viewKey);
    const track: TrackedBlock = {
      view,
      route: q.groupKeys,
      routeKey: routeKeyOf(q.groupKeys),
      startRow: q.startRow,
      kind: block.kind,
      rowIdx: block.rowIdx,
      labels: block.labels,
    };
    return ok({ rows: block.rows, rowCount: block.rowCount, ms: performance.now() - t0, built, track });
  }

  /**
   * Applies one flush tick's ChangeSet to every cached view (never clearing them) and returns what changed
   * per view, for building client deltas. Set-filter value lists are dropped only when a dictionary gained a
   * value that the list for that trader scope lacks.
   */
  applyChanges(cs: ChangeSet, budgetMs = Infinity): ViewChanges[] {
    const grown = this.store.takeDictionaryGrowth();
    this.syncIdentity();
    this.refreshFilterValues(cs, grown);
    const t0 = performance.now();
    // The tick goes into a shared log. A view that cannot be patched now simply stays behind (costing nothing), and
    // when it is next patched the ticks it missed are merged once and shared by every view that missed the same ones.
    if (cs.size > 0 || grown.size > 0) this.log.push({ seq: ++this.seq, cs, grown });
    const stats: ApplyStats = { patched: 0, deferred: 0, unsubscribed: 0, pendingRebuild: 0, stale: 0 };
    const active: View[] = [];
    for (const view of this.cache.values()) {
      if (view.refs === 0 && this.options.patchUnsubscribed !== true) {
        view.markStale();
        stats.unsubscribed++;
        continue;
      }
      if (view.rebuildPending) {
        stats.pendingRebuild++;
        continue;
      }
      view.deferRebuilds = this.options.deferRebuilds !== false;
      active.push(view);
    }
    // The views the most clients are watching go first; a view skipped for several ticks goes ahead of them.
    active.sort((a, b) => Number(b.deferredTicks >= 3) - Number(a.deferredTicks >= 3) || b.refs - a.refs);
    const threshold = this.options.structuralRebuildThreshold ?? STRUCTURAL_REBUILD_THRESHOLD;
    const merged = new Map<number, { cs: ChangeSet; grown: Set<OrderField> } | null>();
    const out: ViewChanges[] = [];
    this.behind = 0;
    for (const view of active) {
      if (view.appliedSeq >= this.seq) continue;
      if (performance.now() - t0 >= budgetMs) {
        view.deferredTicks++;
        stats.deferred++;
        this.behind++;
        continue;
      }
      let pending = merged.get(view.appliedSeq);
      if (pending === undefined) {
        pending = this.mergeSince(view.appliedSeq, threshold * CARRY_REBUILD_FACTOR);
        merged.set(view.appliedSeq, pending);
      }
      if (pending === null && view.deferRebuilds) {
        // Too far behind for a patch to pay: rebuild instead (between ticks, throttled).
        view.rebuildPending = true;
        stats.pendingRebuild++;
        continue;
      }
      const tick = pending ?? this.mergeSince(view.appliedSeq, Infinity);
      out.push(view.applyChanges(tick?.cs ?? cs, tick?.grown ?? grown));
      view.appliedSeq = this.seq;
      if (view.rebuildPending) stats.pendingRebuild++;
      else stats.patched++;
    }
    for (const view of this.cache.values()) if (view.stale) stats.stale++;
    this.pruneLog(active);
    this.lastApply = stats;
    this.cache.rebalance('');
    return out;
  }

  /** The union of every logged tick after `seq`, or null when it holds more rows than `limit`. */
  private mergeSince(seq: number, limit: number): { cs: ChangeSet; grown: Set<OrderField> } | null {
    const ticks = this.log.filter((t) => t.seq > seq);
    if (ticks.length === 1) return { cs: (ticks[0] as LoggedTick).cs, grown: new Set((ticks[0] as LoggedTick).grown) };
    const cs = new ChangeSet();
    const grown = new Set<OrderField>();
    for (const t of ticks) {
      cs.merge(t.cs);
      for (const f of t.grown) grown.add(f);
      if (cs.size > limit) return null;
    }
    return { cs, grown };
  }

  /** Drops logged ticks that every maintained view has already applied. */
  private pruneLog(active: readonly View[]): void {
    let oldest = this.seq;
    for (const v of active) if (!v.rebuildPending) oldest = Math.min(oldest, v.appliedSeq);
    if (this.log.length > 0 && (this.log[0] as LoggedTick).seq <= oldest) this.log = this.log.filter((t) => t.seq > oldest);
  }

  /** Number of ticks logged so far (views record the last one they reflect). */
  get tickSeq(): number {
    return this.seq;
  }

  /** True while some maintained view is behind the latest tick, so a flush with an empty ChangeSet still has work. */
  hasDeferredWork(): boolean {
    return this.behind > 0;
  }

  /**
   * The next view due for a deferred rebuild: one that is tracked, waiting, and not rebuilt within the interval.
   * Views that lost their last client are dropped to stale instead.
   */
  takeRebuild(now = Date.now()): View | null {
    const interval = this.options.rebuildIntervalMs ?? 1_000;
    for (const view of this.cache.values()) {
      if (!view.rebuildPending) continue;
      if (view.refs === 0 && this.options.patchUnsubscribed !== true) {
        view.markStale();
        continue;
      }
      if (now - view.lastRebuildAt >= interval) return view;
    }
    return null;
  }

  /** Rebuilds a view taken from `takeRebuild`. */
  rebuildView(view: View, now = Date.now()): void {
    this.syncIdentity();
    view.rebuild();
    view.appliedSeq = this.seq;
    view.lastRebuildAt = now;
    this.rebuildCount++;
    this.cache.rebalance('');
  }

  /** Evicts views nobody has used for `idleMs` and that no client tracks. */
  sweep(idleMs: number, now = Date.now()): number {
    return this.cache.sweep(idleMs, now);
  }

  /** Rebuilds every cached view from the store (used when an append breaks ascending `orderId` order). */
  rebuildAll(): void {
    this.syncIdentity();
    for (const view of this.cache.values()) {
      view.rebuild();
      view.appliedSeq = this.seq;
    }
  }

  views(): IterableIterator<View> {
    return this.cache.values();
  }

  /** Distinct values of a set-filter column within the trader's scope, ascending, capped at 5,000. */
  setFilterValues(traderId: string, colId: string): Result<string[]> {
    const meta = COLUMN_BY_FIELD.get(colId as OrderField);
    if (meta === undefined) return fail('UNKNOWN_COLUMN', `Unknown column: ${colId}`);
    if (meta.filter !== 'set') return fail('UNSUPPORTED_COLUMN', `Column ${colId} has no set filter`);
    const cacheKey = `${traderId}\u0000${colId}`;
    const cached = this.filterValueCache.get(cacheKey);
    if (cached !== undefined) return ok(cached);

    const col = this.store.enumColumn(meta.field);
    let present: string[];
    if (traderId === TRADER_ALL) {
      present = col.dict.sortedValues();
    } else {
      const trader = this.store.enumColumn('traderId');
      const code = trader.dict.codeOf(traderId);
      const seen = new Uint8Array(col.dict.size);
      if (code !== undefined) {
        const n = this.store.size;
        const tcodes = trader.codes;
        const codes = col.codes;
        for (let i = 0; i < n; i++) if (tcodes[i] === code) seen[codes[i] as number] = 1;
      }
      present = col.dict.sortedValues().filter((v) => seen[col.dict.codeOf(v) as number] === 1);
    }
    const values = present.slice(0, SET_FILTER_VALUE_CAP);
    this.filterValueCache.set(cacheKey, values);
    return ok(values);
  }

  stats(): EngineStats {
    return { cache: this.cache.stats(), lastApply: this.lastApply, rebuilds: this.rebuildCount };
  }

  /** Drops every cached view (benchmarks use this to measure cold requests). */
  clearCaches(): void {
    this.cache.clear();
    this.filterValueCache.clear();
  }

  private buildView(q: NormalizedQuery): View {
    this.syncIdentity();
    const view = new View(this.store, q, this.identity, q.viewKey, this.options.structuralRebuildThreshold);
    view.appliedSeq = this.seq;
    return view;
  }

  private syncIdentity(): void {
    this.identity.appendRange(this.identity.len, this.store.size);
  }

  private refreshFilterValues(cs: ChangeSet, grown: ReadonlySet<OrderField>): void {
    if (this.filterValueCache.size === 0) return;
    for (const key of [...this.filterValueCache.keys()]) {
      const [traderId, colId] = key.split('\u0000') as [string, string];
      const field = colId as OrderField;
      if (grown.has(field)) {
        this.filterValueCache.delete(key);
        continue;
      }
      const values = this.filterValueCache.get(key) as string[];
      const col = this.store.enumColumn(field);
      const trader = this.store.enumColumn('traderId');
      for (const e of cs.entries.values()) {
        if (!e.isNew && !e.fields.has(field)) continue;
        if (traderId !== TRADER_ALL && trader.dict.values[trader.codes[e.row] as number] !== traderId) continue;
        const value = col.dict.values[col.codes[e.row] as number] as string;
        if (!values.includes(value)) {
          this.filterValueCache.delete(key);
          break;
        }
      }
    }
  }
}
