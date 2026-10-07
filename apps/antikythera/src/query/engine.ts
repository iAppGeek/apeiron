import { COLUMN_BY_FIELD, type OrderField, type Row, type SsrmRequest } from '@apeiron/logos';
import type { ColumnarStore } from '../store/columnar-store.js';
import type { ChangeSet } from './changeset.js';
import { fail, ok, type Result } from './errors.js';
import { TRADER_ALL } from './filter.js';
import { normalizeRequest, type NormalizedQuery } from './request.js';
import { RowBuf } from './row-buf.js';
import { ViewCache, type ViewCacheOptions, type ViewCacheStats } from './view-cache.js';
import { View, routeKeyOf, type ViewChanges } from './view.js';

export const SET_FILTER_VALUE_CAP = 5_000;

export type EngineOptions = ViewCacheOptions & {
  /** Largest `endRow - startRow` a client may request. */
  maxBlockRows: number;
  /** Structural changes in one tick above which a view is rebuilt instead of patched (default 5,000). */
  structuralRebuildThreshold?: number;
};

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

export type EngineStats = { cache: ViewCacheStats };

/**
 * Serves SSRM block requests and set-filter value lists from the columnar store. Not tied to any
 * transport: the WebSocket layer only validates frames and calls this.
 */
export class QueryEngine {
  private readonly cache: ViewCache;
  private readonly filterValueCache = new Map<string, string[]>();
  /** The shared 0..n-1 array that views with no filter use as their root. Only ever appended to. */
  private readonly identity = RowBuf.empty();

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
    const built = view === undefined;
    if (view === undefined) {
      view = this.buildView(q);
      this.cache.set(q.viewKey, view);
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
  applyChanges(cs: ChangeSet): ViewChanges[] {
    const grown = this.store.takeDictionaryGrowth();
    this.syncIdentity();
    this.refreshFilterValues(cs, grown);
    const out: ViewChanges[] = [];
    for (const view of this.cache.values()) out.push(view.applyChanges(cs, grown));
    this.cache.rebalance('');
    return out;
  }

  /** Evicts views nobody has used for `idleMs` and that no client tracks. */
  sweep(idleMs: number, now = Date.now()): number {
    return this.cache.sweep(idleMs, now);
  }

  /** Rebuilds every cached view from the store (used when an append breaks ascending `orderId` order). */
  rebuildAll(): void {
    this.syncIdentity();
    for (const view of this.cache.values()) view.rebuild();
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
    return { cache: this.cache.stats() };
  }

  /** Drops every cached view (benchmarks use this to measure cold requests). */
  clearCaches(): void {
    this.cache.clear();
    this.filterValueCache.clear();
  }

  private buildView(q: NormalizedQuery): View {
    this.syncIdentity();
    return new View(this.store, q, this.identity, q.viewKey, this.options.structuralRebuildThreshold);
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
