import type {
  IRowNode,
  RefreshCellsParams,
  RefreshServerSideParams,
  ServerSideTransaction,
  ServerSideTransactionResult,
} from 'ag-grid-community';
import type { Row, ServerMsg } from '@apeiron/logos';
import { planAnchor, readTopRow, type AnchorApi } from './anchor';
import { createRouteDebouncer, realTimers, type Timers } from './route-debouncer';
import type { TickTracker } from './tick-tracker';

export type DeltaMsg = Extract<ServerMsg, { t: 'delta' }>;

/** The slice of `GridApi` the applier uses. The real `GridApi` satisfies it. */
export type DeltaGridApi = AnchorApi & {
  applyServerSideTransaction(transaction: ServerSideTransaction): ServerSideTransactionResult | undefined;
  refreshServerSide(params?: RefreshServerSideParams): void;
  getRowNode(id: string): IRowNode | undefined;
  refreshCells(params?: RefreshCellsParams): void;
  setRowCount(rowCount: number, maxRowFound?: boolean): void;
};

export type ApplyStats = {
  /** Leaf and group rows updated, for the rows-updated-per-second figure. */
  rowsUpdated: number;
  rowsAdded: number;
  /** Updates for rows the grid does not hold (scrolled out of the cache), which are dropped. */
  skipped: number;
  /** The server's count for the root route if this delta carried one, so the status bar can follow it. */
  rootRowCount: number | null;
};

export type DeltaApplierOptions = {
  api: DeltaGridApi;
  /** Fields of the price columns; changes to these get an up or down colour. */
  priceFields: ReadonlySet<string>;
  ticks: TickTracker;
  /** Row id of a group row returned in `groupUpdates` (`"G:" + keys.join("|")`). */
  groupRowId: (route: readonly string[], row: Row) => string;
  /** Called with the number of new orders hidden above a scrolled-down viewport, for the badge. */
  onNewAbove?: (count: number) => void;
  /** Reads the first row the user can see straight from the rendered rows, when the host can. */
  topRowProbe?: () => number | null;
  /** AG Grid refuses `setRowCount` while rows are grouped (error 28); the host says when it may be called. Default always. */
  canSetRowCount?: () => boolean;
  /** The root row count the grid last loaded (the status bar's), for sizing a reload against what it held before. */
  currentRowCount?: () => number | null;
  timers?: Timers;
  /** Each route is refreshed at most once per this long. Default 1000ms. */
  refreshIntervalMs?: number;
  /** How often expired up and down colours are cleared while any are showing. Default 100ms. */
  sweepIntervalMs?: number;
};

export type DeltaApplier = {
  /** Applies one delta to the grid, synchronously. */
  apply(delta: DeltaMsg): ApplyStats;
  /** Call on the grid's `storeRefreshed` event; finishes an anchor that waited for a background refresh. */
  onStoreRefreshed(route: readonly string[] | undefined): void;
  /** Forgets previous values, pending refreshes and pending anchors (trader or codec switch, purge). */
  reset(): void;
  /** The grid is reloading the root from nothing (a purge): rows added meanwhile need one more refresh once it lands. */
  beginReload(): void;
  /** Notes where the user is, before a purge that keeps their place. Returns nothing; `rootLoaded` uses it. */
  savePosition(): void;
  /** The root of the reloaded grid has its first block and row count: put the viewport back where `savePosition` noted. */
  rootLoaded(rowCount: number): void;
  dispose(): void;
};

export const REFRESH_INTERVAL_MS = 1000;
export const SWEEP_INTERVAL_MS = 100;
/** How far past the rows counted since the last refresh an order may move and still be followed. */
export const ANCHOR_SLACK_ROWS = 25;
/** A root reload that raises no `storeRefreshed` is treated as over after this long (ms). */
export const ROOT_RELOAD_WATCHDOG_MS = 4000;
/** Most follow-up root refreshes in a row after rows landed on top during one. */
export const MAX_FOLLOW_UPS = 3;
/** When the saved order is looked for again after a reload, in ms after the root loaded. */
export const RESTORE_RETRY_MS: readonly number[] = [0, 100, 250, 500, 1000, 2000];

/**
 * Applies live `delta` messages to the SSRM grid (Appendix C, "Delta semantics"):
 * 1. adds, one synchronous transaction per route;
 * 2. updates, each partial merged into the row's current data right before one synchronous transaction per route
 *    (the async transaction API is never used: stacked partials would merge against stale data and lose fields);
 * 3. group-row aggregates on the parent route;
 * 4. dirty routes refreshed with `purge: false`, at most once per second per route;
 * 5. the root row count. AG Grid 36 can only set the count of the root store (`api.setRowCount`), and not while rows
 *    are grouped, so other counts rely on the transactions and the dirty-route refresh that accompanies a changed count.
 * Then it keeps the viewport still if new rows landed above it.
 */
export function createDeltaApplier(options: DeltaApplierOptions): DeltaApplier {
  const { api, ticks, priceFields } = options;
  const timers = options.timers ?? realTimers;
  const sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;

  /** The order at the top of the viewport just before the root route refreshes. */
  let snapshot: { rowId: string; topRow: number } | null = null;
  /** The server's latest root row count, and the count the grid's rows last matched (after the previous refresh). */
  let rootCount: number | null = null;
  let settledCount: number | null = null;

  const takeSnapshot = (): void => {
    const topRow = readTopRow(api, options.topRowProbe);
    const rowId = topRow > 0 ? api.getDisplayedRowAtIndex(topRow)?.id : undefined;
    snapshot = typeof rowId === 'string' ? { rowId, topRow } : null;
  };

  /**
   * A refresh reloads the cached blocks with one request each, and they are answered one after another. Rows added on
   * top between two of those answers shift the later blocks against the earlier ones and leave a seam of stale rows
   * that nothing mends (found by S6, where a throttled link stretched the refresh to seconds). So when rows landed on
   * top while a root refresh was in flight, the root is refreshed once more when it ends.
   */
  let rootRefreshing = false;
  let addedWhileRefreshing = false;
  /** Follow-up refreshes in a row; a stream of adds cannot keep the root reloading for ever. */
  let followUps = 0;
  let followUpRequested = false;
  let watchdog: unknown = null;

  /**
   * The root reload is over: either AG Grid said so (`storeRefreshed`), or the watchdog did, because a purge may not
   * raise that event at all. If rows landed on top meanwhile, reload once more.
   */
  const finishRootRefresh = (): void => {
    if (watchdog !== null) timers.clearTimeout(watchdog);
    watchdog = null;
    if (!rootRefreshing) return;
    rootRefreshing = false;
    if (addedWhileRefreshing && followUps < MAX_FOLLOW_UPS) {
      addedWhileRefreshing = false;
      followUpRequested = true;
      refresh.request([]);
    }
  };

  const startRootReload = (): void => {
    rootRefreshing = true;
    addedWhileRefreshing = false;
    if (watchdog !== null) timers.clearTimeout(watchdog);
    watchdog = timers.setTimeout(finishRootRefresh, ROOT_RELOAD_WATCHDOG_MS);
  };

  const refresh = createRouteDebouncer(
    (route) => {
      if (route.length === 0) {
        takeSnapshot();
        followUps = followUpRequested ? followUps + 1 : 0;
        followUpRequested = false;
        startRootReload();
      }
      api.refreshServerSide({ route, purge: false });
    },
    options.refreshIntervalMs ?? REFRESH_INTERVAL_MS,
    timers,
  );

  /** Where the user was before a purge that keeps their place; used once the reloaded root knows its size. */
  let saved: { index: number; rowId: string | null; rowCount: number | null } | null = null;
  const restoreTimers: unknown[] = [];
  const clearRestore = (): void => {
    for (const t of restoreTimers.splice(0)) timers.clearTimeout(t);
  };

  let sweepTimer: unknown = null;
  /** Rows inserted above the viewport by a refresh that has not finished yet. */
  let pendingShift = 0;

  const sweep = (): void => {
    sweepTimer = null;
    const expired = ticks.expire(timers.now());
    if (expired.length > 0) {
      const columns = new Set<string>();
      for (const e of expired) for (const f of e.fields) columns.add(f);
      api.refreshCells({ rowNodes: expired.map((e) => e.node), columns: [...columns], force: true, suppressFlash: true });
    }
    if (ticks.size > 0) sweepTimer = timers.setTimeout(sweep, sweepIntervalMs);
  };

  const scheduleSweep = (): void => {
    if (sweepTimer === null && ticks.size > 0) sweepTimer = timers.setTimeout(sweep, sweepIntervalMs);
  };

  const applyAdds = (delta: DeltaMsg, stats: ApplyStats): number => {
    let insertedAtTop = 0;
    for (const add of delta.adds) {
      if (add.rows.length === 0) continue;
      const result = api.applyServerSideTransaction({ route: add.route, add: add.rows, addIndex: add.addIndex });
      const inserted = result?.add?.length ?? 0;
      stats.rowsAdded += inserted;
      if (add.route.length === 0 && add.addIndex === 0) insertedAtTop += inserted;
    }
    return insertedAtTop;
  };

  const applyUpdates = (delta: DeltaMsg, stats: ApplyStats): void => {
    const now = timers.now();
    for (const { route, rows } of delta.updates) {
      // Keyed by order id so two partials for one row in the same delta fold into each other instead of both
      // merging against the grid's not yet updated data.
      const merged = new Map<string, Record<string, unknown>>();
      for (const partial of rows) {
        const node = api.getRowNode(partial.orderId);
        const current = merged.get(partial.orderId) ?? (node?.data as Record<string, unknown> | undefined);
        if (node === undefined || current === undefined) {
          stats.skipped += 1;
          continue;
        }
        for (const field of priceFields) {
          if (field in partial) ticks.note(node, field, current[field], (partial as Record<string, unknown>)[field], now);
        }
        merged.set(partial.orderId, { ...current, ...partial });
      }
      if (merged.size === 0) continue;
      api.applyServerSideTransaction({ route, update: [...merged.values()] });
      stats.rowsUpdated += merged.size;
    }
  };

  const applyGroupUpdates = (delta: DeltaMsg, stats: ApplyStats): void => {
    for (const { route, rows } of delta.groupUpdates) {
      const merged: Record<string, unknown>[] = [];
      for (const row of rows) {
        const node = api.getRowNode(options.groupRowId(route, row));
        const current = node?.data as Record<string, unknown> | undefined;
        if (current === undefined) {
          stats.skipped += 1;
          continue;
        }
        merged.push({ ...current, ...row });
      }
      if (merged.length === 0) continue;
      api.applyServerSideTransaction({ route, update: merged });
      stats.rowsUpdated += merged.length;
    }
  };

  /**
   * After a background refresh, finds where the order the user was reading has gone and scrolls to it. The server's
   * `newAbove` counts rows above the start of the last root block it was asked for, and a refresh ends by
   * re-requesting block 0, so it undercounts there; the order's own new index is exact. A move much larger than the
   * rows that arrived since the previous refresh (plus a little slack for deltas still in flight) is a reordering,
   * for example a sort on a ticking column, and says nothing about where the user was, so it is left alone.
   * Returns false when the order is not loaded or moved too far, so the caller falls back to `newAbove`.
   */
  const anchorOnOrder = (before: { rowId: string; topRow: number }, settled: number | null): boolean => {
    const rowIndex = api.getRowNode(before.rowId)?.rowIndex;
    if (typeof rowIndex !== 'number') return false;
    // Before the first count is known, the server's own newAbove is the best figure there is.
    const grew = rootCount !== null && settled !== null ? Math.max(0, rootCount - settled) : pendingShift;
    const moved = rowIndex - before.topRow;
    // The order reordered far more than the arrivals explain: it says nothing about where the user was, so the
    // server's newAbove (kept in pendingShift) decides instead.
    if (Math.abs(moved) > grew + ANCHOR_SLACK_ROWS) return false;
    const counted = pendingShift;
    pendingShift = 0;
    if (moved === 0) return true;
    api.ensureIndexVisible(rowIndex, 'top');
    if (moved > counted) options.onNewAbove?.(moved - counted);
    return true;
  };

  return {
    apply(delta): ApplyStats {
      const stats: ApplyStats = { rowsUpdated: 0, rowsAdded: 0, skipped: 0, rootRowCount: null };
      const hasRootAdds = delta.adds.some((a) => a.route.length === 0 && a.rows.length > 0);
      // The top row has to be read before the rows move.
      const topRow = delta.newAbove > 0 || hasRootAdds ? readTopRow(api, options.topRowProbe) : 0;

      const insertedAtTop = applyAdds(delta, stats);
      if (rootRefreshing && hasRootAdds) addedWhileRefreshing = true;
      applyUpdates(delta, stats);
      applyGroupUpdates(delta, stats);
      for (const route of delta.dirtyRoutes) refresh.request(route);
      for (const { route, rowCount } of delta.rowCounts) {
        if (route.length === 0) {
          if (options.canSetRowCount?.() ?? true) api.setRowCount(rowCount);
          stats.rootRowCount = rowCount;
          rootCount = rowCount;
        }
      }

      const plan = planAnchor({ topRow, newAbove: delta.newAbove, insertedAtTop });
      if (plan.badgeDelta > 0) options.onNewAbove?.(plan.badgeDelta);
      if (plan.scrollToRow !== null) {
        if (insertedAtTop > 0) {
          // The rows are already in the grid: put the viewport back over the orders the user was reading.
          api.ensureIndexVisible(plan.scrollToRow, 'top');
        } else {
          // The new rows arrive with a background refresh (the view is not createdAt desc); anchor when it lands.
          pendingShift += plan.badgeDelta;
        }
      }
      scheduleSweep();
      return stats;
    },

    onStoreRefreshed(route): void {
      if (route !== undefined && route.length > 0) return;
      finishRootRefresh();
      const before = snapshot;
      snapshot = null;
      const settled = settledCount;
      settledCount = rootCount;
      if (before !== null && anchorOnOrder(before, settled)) return;
      if (pendingShift === 0) return;
      const shift = pendingShift;
      pendingShift = 0;
      const top = readTopRow(api, options.topRowProbe);
      if (top > 0) api.ensureIndexVisible(top + shift, 'top');
    },

    savePosition(): void {
      // A reload that has not landed yet still owes the place saved by the one before it (flapping reconnects).
      if (saved !== null) return;
      const index = readTopRow(api, options.topRowProbe);
      const rowId = index > 0 ? api.getDisplayedRowAtIndex(index)?.id : undefined;
      if (index <= 0 || !(options.canSetRowCount?.() ?? true)) return;
      saved = { index, rowId: typeof rowId === 'string' ? rowId : null, rowCount: options.currentRowCount?.() ?? rootCount };
    },

    rootLoaded(rowCount: number): void {
      const place = saved;
      saved = null;
      if (place === null || rowCount <= 0) return;
      // New orders arrive on top of a createdAt-descending table, so the order the user was reading is that many rows lower.
      const grew = place.rowCount === null ? 0 : Math.max(0, rowCount - place.rowCount);
      const target = Math.min(rowCount - 1, place.index + grew);
      if (grew > 0) options.onNewAbove?.(grew);
      clearRestore();
      // Scroll first, so the grid loads the blocks there; then, as they land, anchor on the order itself.
      RESTORE_RETRY_MS.forEach((ms) => {
        restoreTimers.push(
          timers.setTimeout(() => {
            const node = place.rowId === null ? undefined : api.getRowNode(place.rowId);
            const found = typeof node?.rowIndex === 'number' ? node.rowIndex : null;
            const exact = found !== null && Math.abs(found - target) <= grew + ANCHOR_SLACK_ROWS ? found : null;
            // The grid may not have laid the new root out yet (the first tries can be ignored), so ask again until the
            // viewport is where it should be; once the order itself is loaded, that settles it.
            const row = exact ?? target;
            if (Math.abs(readTopRow(api, options.topRowProbe) - row) > 1) api.ensureIndexVisible(row, 'top');
            if (exact !== null) clearRestore();
          }, ms),
        );
      });
    },

    reset(): void {
      rootRefreshing = false;
      addedWhileRefreshing = false;
      followUps = 0;
      followUpRequested = false;
      if (watchdog !== null) timers.clearTimeout(watchdog);
      watchdog = null;
      ticks.clear();
      refresh.reset();
      pendingShift = 0;
      snapshot = null;
      rootCount = null;
      settledCount = null;
      if (sweepTimer !== null) timers.clearTimeout(sweepTimer);
      sweepTimer = null;
    },

    beginReload(): void {
      followUps = 0;
      followUpRequested = false;
      startRootReload();
    },

    dispose(): void {
      clearRestore();
      saved = null;
      this.reset();
    },
  };
}
