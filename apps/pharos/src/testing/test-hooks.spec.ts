import type { GridApi, IRowNode } from 'ag-grid-community';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetAppStore, useAppStore } from '../state/app-store';
import { installHooks, recordDelta, recordPurge, recordRequest, resetCountersForTest, type ApeironTestHooks } from './test-hooks';

type HookWindow = Window & { __apeironTest?: ApeironTestHooks };

const node = (partial: Partial<IRowNode> & { data?: unknown }): IRowNode => partial as unknown as IRowNode;

function fakeApi(nodes: IRowNode[]): GridApi {
  return {
    forEachNode: (cb: (n: IRowNode, i: number) => void): void => {
      nodes.forEach((n, i) => {
        cb(n, i);
      });
    },
    getServerSideGroupLevelState: () => [{ rowCount: 1234 }],
    getFirstDisplayedRowIndex: () => 7,
    getColumnState: () => [
      { colId: 'a', sort: null },
      { colId: 'unrealisedPnlUsd', sort: 'desc', sortIndex: 0 },
    ],
    getFilterModel: () => ({ status: { filterType: 'set', values: ['LIVE'] } }),
    getRowGroupColumns: () => [{ getColId: () => 'currencyPair' }],
  } as unknown as GridApi;
}

describe('test hooks', () => {
  let remove: () => void = () => undefined;
  const hooks = (): ApeironTestHooks => {
    const h = (window as HookWindow).__apeironTest;
    if (h === undefined) throw new Error('hooks not installed');
    return h;
  };

  beforeEach(() => {
    resetAppStore();
    resetCountersForTest();
  });
  afterEach(() => {
    remove();
  });

  it('installs and removes window.__apeironTest', () => {
    remove = installHooks(fakeApi([]), () => 0);
    expect((window as HookWindow).__apeironTest).toBeDefined();
    remove();
    expect((window as HookWindow).__apeironTest).toBeUndefined();
  });

  it('lists loaded leaf rows with their index and group keys, copying the data', () => {
    const group = node({ group: true, key: 'EURUSD', level: 0, parent: node({ level: -1, key: null }), rowIndex: 0, id: 'G:EURUSD', data: { childCount: 2 } });
    const leaf = node({ group: false, id: 'O1', rowIndex: 1, parent: group, data: { orderId: 'O1', filledQty: 5 } });
    const stub = node({ group: false, id: 'x', data: undefined });
    remove = installHooks(fakeApi([group, leaf, stub]), () => 0);
    const rows = hooks().loadedRows();
    expect(rows).toEqual([{ rowIndex: 1, childIndex: null, id: 'O1', groupKeys: ['EURUSD'], data: { orderId: 'O1', filledQty: 5 } }]);
    expect(rows[0]?.data).not.toBe(leaf.data);
    expect(hooks().groupRows()).toMatchObject([{ id: 'G:EURUSD', level: 0, key: 'EURUSD', groupKeys: [], data: { childCount: 2 } }]);
  });

  it('reports the root count, view state and connection from the grid and the store', () => {
    remove = installHooks(fakeApi([]), () => 0);
    useAppStore.setState({ status: 'connected', reconnects: 4, lastCloseReason: 'stale:8000ms', confirmedTrader: 'T2', codec: 'msgpack', rowCount: 99 });
    expect(hooks().rootRowCount()).toBe(1234);
    expect(hooks().statusBarRowCount()).toBe(99);
    expect(hooks().firstDisplayedRow()).toBe(7);
    expect(hooks().connection()).toEqual({ state: 'connected', welcomed: false, reconnects: 4, lastCloseReason: 'stale:8000ms', closes: 0, closeHistory: [], pendingRequests: 0, toastHistory: [] });
    expect(hooks().viewState()).toEqual({
      trader: 'T2',
      codec: 'msgpack',
      sort: [{ colId: 'unrealisedPnlUsd', sort: 'desc' }],
      filter: { status: { filterType: 'set', values: ['LIVE'] } },
      grouping: ['currencyPair'],
      expanded: [],
    });
  });

  it('keeps a copy of the latest getRows request', () => {
    remove = installHooks(fakeApi([]), () => 0);
    expect(hooks().lastRequest()).toBeNull();
    const request = { startRow: 0, endRow: 100, rowGroupCols: [], valueCols: [], groupKeys: [], sortModel: [] };
    recordRequest(request);
    expect(hooks().lastRequest()).toEqual(request);
    expect(hooks().lastRequest()).not.toBe(request);
  });

  it('reports pending requests as part of the connection, and busy while any are outstanding', () => {
    let pending = 2;
    remove = installHooks(fakeApi([]), () => pending);
    useAppStore.setState({ status: 'connected', welcomed: true, requestedTrader: 'ALL', confirmedTrader: 'ALL', notReady: false });
    expect(hooks().connection().pendingRequests).toBe(2);
    expect(hooks().busy()).toBe(true);
    pending = 0;
    expect(hooks().busy()).toBe(false);
  });

  it('counts deltas, rows and purges', () => {
    remove = installHooks(fakeApi([]), () => 0);
    recordDelta({ rowsUpdated: 3, rowsAdded: 1, skipped: 0, rootRowCount: null });
    recordDelta(undefined);
    recordPurge();
    const c = hooks().counters();
    expect(c).toMatchObject({ deltasApplied: 2, rowsUpdated: 3, rowsAdded: 1, purges: 1 });
    expect(c.lastDeltaAt).toBeGreaterThan(0);
  });
});
