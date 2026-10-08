import type { Row, SsrmRequest } from '@apeiron/logos';
import type { GridApi, IRowNode } from 'ag-grid-community';
import type { ApplyStats } from '../grid/apply-delta';
import { useAppStore, type SummaryStats } from '../state/app-store';

/** A leaf row the grid holds, with where it sits. */
export type LoadedRow = {
  /** Display index; null for a row that is loaded but not currently displayed. */
  rowIndex: number | null;
  /** Position among its parent's children (the index a `getRows` for that route uses), when the grid knows it. */
  childIndex: number | null;
  id: string | undefined;
  /** Group keys from the root down to this row's parent. */
  groupKeys: string[];
  data: Row;
};

export type GroupRow = {
  rowIndex: number | null;
  childIndex: number | null;
  id: string | undefined;
  level: number;
  key: string | null;
  groupKeys: string[];
  expanded: boolean;
  /** `childCount` plus the aggregates, as the grid shows them. */
  data: Row;
};

export type ConnectionInfo = {
  state: 'connecting' | 'connected' | 'reconnecting' | 'closed';
  welcomed: boolean;
  reconnects: number;
  lastCloseReason: string | null;
  closes: number;
  closeHistory: string[];
  /** Requests and hellos still waiting for the server; must be zero once things are quiet. */
  pendingRequests: number;
  /** Every toast shown so far (`error: text`), oldest first. */
  toastHistory: string[];
};

export type TestCounters = {
  deltasApplied: number;
  rowsUpdated: number;
  rowsAdded: number;
  /** Row updates the server sent for rows the grid did not hold, which were dropped. */
  skipped: number;
  purges: number;
  /** `Date.now()` when the last delta was applied; 0 before any. */
  lastDeltaAt: number;
};

export type ViewState = {
  trader: string;
  codec: string;
  sort: { colId: string; sort: string }[];
  filter: Record<string, unknown>;
  grouping: string[];
  /** Group keys of every expanded group row. */
  expanded: string[][];
};

export type LatencyInfo = { p50: number | null; p95: number | null };

/** The read-only surface Playwright uses to look inside the page. It exists only in builds made with `VITE_TEST_HOOKS=1`. */
export type ApeironTestHooks = {
  loadedRows(): LoadedRow[];
  groupRows(): GroupRow[];
  /** Row count of the grid's root store (rows when flat, groups when grouped); null before the first block. */
  rootRowCount(): number | null;
  /** The count the status bar shows, as the server last reported it. */
  statusBarRowCount(): number | null;
  /** The first row index the viewport shows, or null. */
  firstDisplayedRow(): number | null;
  summary(): SummaryStats | null;
  connection(): ConnectionInfo;
  counters(): TestCounters;
  viewState(): ViewState;
  latency(): LatencyInfo;
  /** The latest `getRows` request the grid sent; its columns, sort and filter describe the current view. */
  lastRequest(): SsrmRequest | null;
  /** True while a getRows is loading, or the grid is switching trader or codec. */
  busy(): boolean;
};

type HookWindow = Window & { __apeironTest?: ApeironTestHooks };

let lastRequest: SsrmRequest | null = null;

const counters: TestCounters = { deltasApplied: 0, rowsUpdated: 0, rowsAdded: 0, skipped: 0, purges: 0, lastDeltaAt: 0 };

const keysOf = (node: IRowNode): string[] => {
  const keys: string[] = [];
  for (let parent = node.parent; parent !== null && parent !== undefined; parent = parent.parent) {
    if (parent.key !== null && parent.key !== undefined && parent.level >= 0) keys.unshift(parent.key);
  }
  return keys;
};

const childIndexOf = (node: IRowNode): number | null => (typeof node.childIndex === 'number' && node.childIndex >= 0 ? node.childIndex : null);

const rowOf = (data: unknown): Row => ({ ...(data as Row) });

/** Called from the delta handler: counts the delta that was just applied. */
export function recordDelta(stats: ApplyStats | void): void {
  counters.deltasApplied += 1;
  counters.lastDeltaAt = Date.now();
  if (stats === undefined) return;
  counters.rowsUpdated += stats.rowsUpdated;
  counters.rowsAdded += stats.rowsAdded;
  counters.skipped += stats.skipped;
}

export function recordRequest(request: SsrmRequest): void {
  lastRequest = request;
}

export function recordPurge(): void {
  counters.purges += 1;
}

/** Publishes `window.__apeironTest` for the given grid and returns a function that removes it. */
export function installHooks(api: GridApi, pendingRequests: () => number): () => void {
  const hooks: ApeironTestHooks = {
    loadedRows(): LoadedRow[] {
      const out: LoadedRow[] = [];
      api.forEachNode((node) => {
        if (node.group === true || node.data === undefined || node.data === null) return;
        out.push({ rowIndex: node.rowIndex, childIndex: childIndexOf(node), id: node.id, groupKeys: keysOf(node), data: rowOf(node.data) });
      });
      return out;
    },
    groupRows(): GroupRow[] {
      const out: GroupRow[] = [];
      api.forEachNode((node) => {
        if (node.group !== true) return;
        const data: Row = { ...rowOf(node.data), ...(node.aggData as Row | undefined) };
        out.push({
          rowIndex: node.rowIndex,
          childIndex: childIndexOf(node),
          id: node.id,
          level: node.level,
          key: node.key ?? null,
          groupKeys: keysOf(node),
          expanded: node.expanded === true,
          data,
        });
      });
      return out;
    },
    rootRowCount(): number | null {
      const level = api.getServerSideGroupLevelState()[0];
      return level === undefined ? null : level.rowCount;
    },
    statusBarRowCount(): number | null {
      return useAppStore.getState().rowCount;
    },
    firstDisplayedRow(): number | null {
      const index = api.getFirstDisplayedRowIndex();
      return index < 0 ? null : index;
    },
    summary(): SummaryStats | null {
      return useAppStore.getState().summary;
    },
    connection(): ConnectionInfo {
      const s = useAppStore.getState();
      return {
        state: s.status,
        welcomed: s.welcomed,
        reconnects: s.reconnects,
        lastCloseReason: s.lastCloseReason,
        closes: s.closes,
        closeHistory: [...s.closeHistory],
        pendingRequests: pendingRequests(),
        toastHistory: [...s.toastHistory],
      };
    },
    counters(): TestCounters {
      return { ...counters };
    },
    viewState(): ViewState {
      const s = useAppStore.getState();
      const state = api.getColumnState();
      const sort = state
        .filter((c) => c.sort !== null && c.sort !== undefined)
        .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
        .map((c) => ({ colId: c.colId, sort: String(c.sort) }));
      const expanded: string[][] = [];
      api.forEachNode((node) => {
        if (node.group === true && node.expanded) expanded.push([...keysOf(node), ...(node.key === null || node.key === undefined ? [] : [node.key])]);
      });
      return {
        trader: s.confirmedTrader,
        codec: s.codec,
        sort,
        filter: api.getFilterModel() as Record<string, unknown>,
        grouping: api.getRowGroupColumns().map((c) => c.getColId()),
        expanded,
      };
    },
    latency(): LatencyInfo {
      const s = useAppStore.getState();
      return { p50: s.latencyP50Ms, p95: s.latencyP95Ms };
    },
    lastRequest(): SsrmRequest | null {
      return lastRequest === null ? null : structuredClone(lastRequest);
    },
    busy(): boolean {
      const s = useAppStore.getState();
      return !s.welcomed || s.notReady || s.status !== 'connected' || s.requestedTrader !== s.confirmedTrader || pendingRequests() > 0;
    },
  };
  const target: HookWindow = window;
  target.__apeironTest = hooks;
  return (): void => {
    if (target.__apeironTest === hooks) delete target.__apeironTest;
  };
}

export const resetCountersForTest = (): void => {
  counters.deltasApplied = 0;
  counters.rowsUpdated = 0;
  counters.rowsAdded = 0;
  counters.skipped = 0;
  counters.purges = 0;
  counters.lastDeltaAt = 0;
  lastRequest = null;
};
