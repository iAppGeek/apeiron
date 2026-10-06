import { COLUMN_BY_FIELD, type OrderField, type Row, type SsrmRequest } from '@apeiron/logos';
import type { ColumnarStore } from '../store/columnar-store.js';
import { fail, ok, type Result } from './errors.js';
import { TRADER_ALL, compileFilter, filterRows } from './filter.js';
import { normalizeRequest, type NormalizedQuery } from './request.js';
import { ViewCache, type ViewCacheOptions, type ViewCacheStats } from './view-cache.js';
import { View } from './view.js';

export const SET_FILTER_VALUE_CAP = 5_000;

export type EngineOptions = ViewCacheOptions & {
  /** Largest `endRow - startRow` a client may request. */
  maxBlockRows: number;
};

export type RowsResult = {
  rows: Row[];
  /** Exact number of rows at the requested level. */
  rowCount: number;
  /** Server processing time for this request. */
  ms: number;
  /** True when the request had to build its view (a cold request). */
  built: boolean;
};

export type EngineStats = { cache: ViewCacheStats; storeVersion: number };

/**
 * Serves SSRM block requests and set-filter value lists from the columnar store. Not tied to any
 * transport: the WebSocket layer only validates frames and calls this.
 */
export class QueryEngine {
  private readonly cache: ViewCache;
  private readonly filterValueCache = new Map<string, string[]>();
  private identity: Uint32Array | null = null;
  private seenVersion: number;

  constructor(
    private readonly store: ColumnarStore,
    private readonly options: EngineOptions,
  ) {
    this.cache = new ViewCache(options);
    this.seenVersion = store.version;
  }

  getRows(traderId: string, req: SsrmRequest): Result<RowsResult> {
    const t0 = performance.now();
    this.syncVersion();
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
    return ok({ rows: block.rows, rowCount: block.rowCount, ms: performance.now() - t0, built });
  }

  /** Distinct values of a set-filter column within the trader's scope, ascending, capped at 5,000. */
  setFilterValues(traderId: string, colId: string): Result<string[]> {
    this.syncVersion();
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
    return { cache: this.cache.stats(), storeVersion: this.seenVersion };
  }

  /** Drops every cached view (benchmarks use this to measure cold requests). */
  clearCaches(): void {
    this.cache.clear();
    this.filterValueCache.clear();
  }

  private buildView(q: NormalizedQuery): View {
    const preds = compileFilter(this.store, q.filter, q.traderId);
    const n = this.store.size;
    if (preds.length === 0) return new View(this.store, q, this.allRows(n), false);
    return new View(this.store, q, filterRows(n, preds), true);
  }

  private allRows(n: number): Uint32Array {
    if (this.identity === null || this.identity.length !== n) this.identity = filterRows(n, []);
    return this.identity;
  }

  /** Cached views and value lists describe the store as it was; any append invalidates them. */
  private syncVersion(): void {
    if (this.store.version === this.seenVersion) return;
    this.seenVersion = this.store.version;
    this.cache.clear();
    this.filterValueCache.clear();
    this.identity = null;
  }
}
