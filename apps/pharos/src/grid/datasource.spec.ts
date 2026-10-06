import type { IServerSideGetRowsParams, IServerSideGetRowsRequest } from 'ag-grid-community';
import { describe, expect, it, vi } from 'vitest';
import { RequestError } from '../transport/client';
import { createDatasource, stripUndefined, toSsrmRequest, type DatasourceDeps } from './datasource';

const agRequest = (over: Partial<IServerSideGetRowsRequest> = {}): IServerSideGetRowsRequest =>
  ({
    startRow: 0,
    endRow: 100,
    rowGroupCols: [],
    valueCols: [],
    pivotCols: [],
    pivotMode: false,
    groupKeys: [],
    sortModel: [{ colId: 'createdAt', sort: 'desc' }],
    filterModel: {},
    ...over,
  }) as IServerSideGetRowsRequest;

type Params = IServerSideGetRowsParams & { success: ReturnType<typeof vi.fn>; fail: ReturnType<typeof vi.fn> };
const makeParams = (request: IServerSideGetRowsRequest = agRequest()): Params =>
  ({ request, success: vi.fn(), fail: vi.fn() }) as unknown as Params;

type Harness = {
  deps: DatasourceDeps;
  getRows: ReturnType<typeof vi.fn>;
  onRootRowCount: ReturnType<typeof vi.fn>;
  onNotReady: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;
};
const makeHarness = (): Harness => {
  const getRows = vi.fn();
  const onRootRowCount = vi.fn();
  const onNotReady = vi.fn();
  const onError = vi.fn();
  const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
  return {
    deps: { client: { getRows }, onRootRowCount, onNotReady, onError, sleep },
    getRows,
    onRootRowCount,
    onNotReady,
    onError,
    sleep,
  };
};

const rows = { rows: [{ orderId: 'A' }], rowCount: 1_000_000, ms: 2 };

describe('toSsrmRequest', () => {
  it('passes through only the SsrmRequest fields', () => {
    const out = toSsrmRequest(
      agRequest({
        rowGroupCols: [{ id: 'currencyPair', displayName: 'Pair', field: 'currencyPair', aggFunc: 'x' }],
        valueCols: [{ id: 'notionalUsd', displayName: 'Notional USD', field: 'notionalUsd', aggFunc: 'sum' }],
        groupKeys: ['EURUSD'],
        sortModel: [{ colId: 'ag-Grid-AutoColumn', sort: 'asc' }],
        filterModel: { status: { filterType: 'set', values: ['LIVE'] } },
      }),
    );
    expect(Object.keys(out).sort()).toEqual(
      ['endRow', 'filterModel', 'groupKeys', 'pivotMode', 'rowGroupCols', 'sortModel', 'startRow', 'valueCols'].sort(),
    );
    expect(out.rowGroupCols).toEqual([{ id: 'currencyPair', field: 'currencyPair', displayName: 'Pair' }]);
    expect(out.valueCols).toEqual([{ id: 'notionalUsd', field: 'notionalUsd', displayName: 'Notional USD', aggFunc: 'sum' }]);
    expect(out.filterModel).toEqual({ status: { filterType: 'set', values: ['LIVE'] } });
  });

  it('never contains undefined values (msgpack would turn them into null)', () => {
    const out = toSsrmRequest(
      agRequest({
        rowGroupCols: [{ id: 'side', displayName: 'Side', field: undefined }],
        filterModel: { createdAt: { filterType: 'date', type: 'equals', dateFrom: '2026-01-01 00:00:00', dateTo: undefined } },
      }),
    );
    expect(out.rowGroupCols[0]).toEqual({ id: 'side', displayName: 'Side' });
    expect(out.filterModel).toEqual({ createdAt: { filterType: 'date', type: 'equals', dateFrom: '2026-01-01 00:00:00' } });
    expect(JSON.stringify(out)).not.toContain('undefined');
  });

  it('defaults missing filterModel to null and rows to the block', () => {
    const out = toSsrmRequest(agRequest({ filterModel: undefined, startRow: undefined, endRow: undefined }));
    expect(out.filterModel).toBeNull();
    expect(out.startRow).toBe(0);
    expect(out.endRow).toBe(0);
  });
});

describe('stripUndefined', () => {
  it('removes undefined deeply and keeps everything else', () => {
    expect(stripUndefined({ a: 1, b: undefined, c: [{ d: undefined, e: null }], f: 'x' })).toEqual({
      a: 1,
      c: [{ e: null }],
      f: 'x',
    });
  });
});

describe('createDatasource', () => {
  it('passes the request to getRows and answers success with rowData and rowCount', async () => {
    const h = makeHarness();
    h.getRows.mockResolvedValue(rows);
    const params = makeParams();
    createDatasource(h.deps).getRows(params);
    await vi.waitFor(() => {
      expect(params.success).toHaveBeenCalledWith({ rowData: rows.rows, rowCount: 1_000_000 });
    });
    expect(h.getRows).toHaveBeenCalledWith(toSsrmRequest(params.request));
    expect(params.fail).not.toHaveBeenCalled();
    expect(h.onRootRowCount).toHaveBeenCalledWith(1_000_000);
  });

  it('only reports the root row count for root-level requests', async () => {
    const h = makeHarness();
    h.getRows.mockResolvedValue({ rows: [], rowCount: 7, ms: 1 });
    const params = makeParams(agRequest({ groupKeys: ['EURUSD'], rowGroupCols: [{ id: 'currencyPair', displayName: 'Pair', field: 'currencyPair' }] }));
    createDatasource(h.deps).getRows(params);
    await vi.waitFor(() => {
      expect(params.success).toHaveBeenCalled();
    });
    expect(h.onRootRowCount).not.toHaveBeenCalled();
  });

  it('calls fail and reports other server errors', async () => {
    const h = makeHarness();
    h.getRows.mockRejectedValue(new RequestError({ code: 'UNSUPPORTED_FILTER', message: 'bad filter' }));
    const params = makeParams();
    createDatasource(h.deps).getRows(params);
    await vi.waitFor(() => {
      expect(params.fail).toHaveBeenCalledTimes(1);
    });
    expect(params.success).not.toHaveBeenCalled();
    expect(h.onError).toHaveBeenCalledWith({ code: 'UNSUPPORTED_FILTER', message: 'bad filter' });
    expect(h.sleep).not.toHaveBeenCalled();
  });

  it('treats non-RequestError exceptions as INTERNAL', async () => {
    const h = makeHarness();
    h.getRows.mockRejectedValue(new Error('boom'));
    const params = makeParams();
    createDatasource(h.deps).getRows(params);
    await vi.waitFor(() => {
      expect(params.fail).toHaveBeenCalled();
    });
    expect(h.onError).toHaveBeenCalledWith({ code: 'INTERNAL', message: 'boom' });
  });

  it('retries NOT_READY with growing backoff, shows the loading state, then succeeds', async () => {
    const h = makeHarness();
    const notReady = new RequestError({ code: 'NOT_READY', message: 'loading' });
    h.getRows.mockRejectedValueOnce(notReady).mockRejectedValueOnce(notReady).mockResolvedValue(rows);
    const params = makeParams();
    createDatasource({ ...h.deps, retry: { baseMs: 100, maxMs: 250, factor: 2 } }).getRows(params);
    await vi.waitFor(() => {
      expect(params.success).toHaveBeenCalled();
    });
    expect(h.getRows).toHaveBeenCalledTimes(3);
    expect(h.sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
    expect(h.onNotReady.mock.calls.map((c) => c[0])).toEqual([true, false]);
    expect(h.onError).not.toHaveBeenCalled();
    expect(params.fail).not.toHaveBeenCalled();
  });

  it('caps the backoff at maxMs', async () => {
    const h = makeHarness();
    const notReady = new RequestError({ code: 'NOT_READY', message: 'loading' });
    h.getRows
      .mockRejectedValueOnce(notReady)
      .mockRejectedValueOnce(notReady)
      .mockRejectedValueOnce(notReady)
      .mockResolvedValue(rows);
    const params = makeParams();
    createDatasource({ ...h.deps, retry: { baseMs: 100, maxMs: 250, factor: 2 } }).getRows(params);
    await vi.waitFor(() => {
      expect(params.success).toHaveBeenCalled();
    });
    expect(h.sleep.mock.calls.map((c) => c[0])).toEqual([100, 200, 250]);
  });

  it('waits out a dropped connection silently, without the loading overlay', async () => {
    const h = makeHarness();
    h.getRows.mockRejectedValueOnce(new RequestError({ code: 'DISCONNECTED', message: 'gone' })).mockResolvedValue(rows);
    const params = makeParams();
    createDatasource(h.deps).getRows(params);
    await vi.waitFor(() => {
      expect(params.success).toHaveBeenCalled();
    });
    expect(h.onNotReady).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
  });

  it('keeps the overlay up until the last waiting request finishes', async () => {
    const h = makeHarness();
    const notReady = new RequestError({ code: 'NOT_READY', message: 'loading' });
    let release: (() => void) | undefined;
    h.sleep.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    h.getRows.mockRejectedValueOnce(notReady).mockResolvedValue(rows);
    const ds = createDatasource(h.deps);
    const a = makeParams();
    ds.getRows(a);
    await vi.waitFor(() => {
      expect(h.onNotReady).toHaveBeenCalledWith(true);
    });
    release?.();
    await vi.waitFor(() => {
      expect(a.success).toHaveBeenCalled();
    });
    expect(h.onNotReady).toHaveBeenLastCalledWith(false);
  });

  it('stops retrying and clears the overlay when destroyed', async () => {
    const h = makeHarness();
    h.getRows.mockRejectedValue(new RequestError({ code: 'NOT_READY', message: 'loading' }));
    let release: (() => void) | undefined;
    h.sleep.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const ds = createDatasource(h.deps);
    const params = makeParams();
    ds.getRows(params);
    await vi.waitFor(() => {
      expect(h.onNotReady).toHaveBeenCalledWith(true);
    });
    ds.destroy?.();
    release?.();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.getRows).toHaveBeenCalledTimes(1);
    expect(params.success).not.toHaveBeenCalled();
    expect(params.fail).not.toHaveBeenCalled();
    expect(h.onNotReady).toHaveBeenLastCalledWith(false);
  });
});
