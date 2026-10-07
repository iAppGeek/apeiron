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
  dispose(): void;
};

export const REFRESH_INTERVAL_MS = 1000;
export const SWEEP_INTERVAL_MS = 100;

/**
 * Applies live `delta` messages to the SSRM grid (Appendix C, "Delta semantics"):
 * 1. adds, one synchronous transaction per route;
 * 2. updates, each partial merged into the row's current data right before one synchronous transaction per route
 *    (the async transaction API is never used: stacked partials would merge against stale data and lose fields);
 * 3. group-row aggregates on the parent route;
 * 4. dirty routes refreshed with `purge: false`, at most once per second per route;
 * 5. the root row count. AG Grid 36 can only set the count of the root store (`api.setRowCount`), so counts of
 *    other routes rely on the transactions and the dirty-route refresh that accompanies a changed count.
 * Then it keeps the viewport still if new rows landed above it.
 */
export function createDeltaApplier(options: DeltaApplierOptions): DeltaApplier {
  const { api, ticks, priceFields } = options;
  const timers = options.timers ?? realTimers;
  const sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;

  const refresh = createRouteDebouncer(
    (route) => {
      api.refreshServerSide({ route, purge: false });
    },
    options.refreshIntervalMs ?? REFRESH_INTERVAL_MS,
    timers,
  );

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

  return {
    apply(delta): ApplyStats {
      const stats: ApplyStats = { rowsUpdated: 0, rowsAdded: 0, skipped: 0, rootRowCount: null };
      const hasRootAdds = delta.adds.some((a) => a.route.length === 0 && a.rows.length > 0);
      // The top row has to be read before the rows move.
      const topRow = delta.newAbove > 0 || hasRootAdds ? readTopRow(api) : 0;

      const insertedAtTop = applyAdds(delta, stats);
      applyUpdates(delta, stats);
      applyGroupUpdates(delta, stats);
      for (const route of delta.dirtyRoutes) refresh.request(route);
      for (const { route, rowCount } of delta.rowCounts) {
        if (route.length === 0) {
          api.setRowCount(rowCount);
          stats.rootRowCount = rowCount;
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
      if (pendingShift === 0 || (route !== undefined && route.length > 0)) return;
      const shift = pendingShift;
      pendingShift = 0;
      const top = readTopRow(api);
      if (top > 0) api.ensureIndexVisible(top + shift, 'top');
    },

    reset(): void {
      ticks.clear();
      refresh.reset();
      pendingShift = 0;
      if (sweepTimer !== null) timers.clearTimeout(sweepTimer);
      sweepTimer = null;
    },

    dispose(): void {
      this.reset();
    },
  };
}
