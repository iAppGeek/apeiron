import type { IServerSideDatasource, IServerSideGetRowsParams, IServerSideGetRowsRequest } from 'ag-grid-community';
import type { SsrmRequest } from '@apeiron/logos';
import { RequestError, type BlotterClient } from '../transport/client';
import type { FailureCode } from '../transport/messages';
import { isRetryable } from './errors';

/** Drops `undefined` recursively. msgpack would encode it as `null`, which the server's schema rejects. */
export function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (v !== undefined) out[key] = stripUndefined(v);
    }
    return out;
  }
  return value;
}

type ColumnVo = { id: string; field?: string; displayName?: string; aggFunc?: string };

function pickColumn(col: ColumnVo, withAgg: boolean): ColumnVo {
  const out: ColumnVo = { id: col.id };
  if (col.field !== undefined) out.field = col.field;
  if (col.displayName !== undefined) out.displayName = col.displayName;
  if (withAgg && col.aggFunc !== undefined) out.aggFunc = col.aggFunc;
  return out;
}

/** Reduces AG Grid's request to exactly the fields of `SsrmRequest`. */
export function toSsrmRequest(request: IServerSideGetRowsRequest): SsrmRequest {
  const startRow = request.startRow ?? 0;
  const out: SsrmRequest = {
    startRow,
    endRow: request.endRow ?? startRow,
    rowGroupCols: request.rowGroupCols.map((c) => pickColumn(c, false)),
    valueCols: request.valueCols.map((c) => pickColumn(c, true)),
    groupKeys: request.groupKeys.map(String),
    sortModel: request.sortModel.map((s) => ({ colId: s.colId, sort: s.sort })),
  };
  if (request.pivotMode !== undefined) out.pivotMode = request.pivotMode;
  const filterModel = stripUndefined(request.filterModel ?? null);
  out.filterModel = filterModel as SsrmRequest['filterModel'];
  return out;
}

export type RetryPolicy = {
  baseMs: number;
  maxMs: number;
  factor: number;
};

export const DEFAULT_RETRY: RetryPolicy = { baseMs: 400, maxMs: 5000, factor: 1.6 };

export type DatasourceDeps = {
  client: Pick<BlotterClient, 'getRows'>;
  /** Called with the exact row count of the root level after each root block loads. */
  onRootRowCount: (rowCount: number, grouped: boolean) => void;
  /** True while at least one request is waiting for the server to finish loading orders. */
  onNotReady: (waiting: boolean) => void;
  onError: (failure: { code: FailureCode; message: string }) => void;
  retry?: RetryPolicy;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** The SSRM datasource adapter: AG Grid requests in, `getRows` over the worker transport out. */
export function createDatasource(deps: DatasourceDeps): IServerSideDatasource {
  const policy = deps.retry ?? DEFAULT_RETRY;
  const sleep = deps.sleep ?? defaultSleep;
  const waiting = new Set<number>();
  let destroyed = false;
  let nextTicket = 0;

  const setWaiting = (ticket: number, on: boolean): void => {
    const before = waiting.size > 0;
    if (on) waiting.add(ticket);
    else waiting.delete(ticket);
    if (before !== waiting.size > 0) deps.onNotReady(waiting.size > 0);
  };

  const load = async (params: IServerSideGetRowsParams): Promise<void> => {
    const ticket = nextTicket++;
    const request = toSsrmRequest(params.request);
    let delay = policy.baseMs;
    try {
      for (;;) {
        if (destroyed) return;
        try {
          const result = await deps.client.getRows(request);
          if (destroyed) return;
          if (request.groupKeys.length === 0) deps.onRootRowCount(result.rowCount, request.rowGroupCols.length > 0);
          params.success({ rowData: result.rows, rowCount: result.rowCount });
          return;
        } catch (error) {
          if (destroyed) return;
          const failure =
            error instanceof RequestError
              ? { code: error.code, message: error.message }
              : { code: 'INTERNAL' as const, message: error instanceof Error ? error.message : String(error) };
          if (!isRetryable(failure.code)) {
            deps.onError(failure);
            params.fail();
            return;
          }
          setWaiting(ticket, failure.code === 'NOT_READY');
          await sleep(delay);
          delay = Math.min(policy.maxMs, Math.round(delay * policy.factor));
        }
      }
    } finally {
      setWaiting(ticket, false);
    }
  };

  return {
    getRows(params: IServerSideGetRowsParams): void {
      void load(params);
    },
    destroy(): void {
      destroyed = true;
      waiting.clear();
      deps.onNotReady(false);
    },
  };
}
