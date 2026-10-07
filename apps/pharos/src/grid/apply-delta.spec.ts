import type { IRowNode, RefreshCellsParams, ServerSideTransaction } from 'ag-grid-community';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeltaApplier, type DeltaApplierOptions, type DeltaGridApi, type DeltaMsg } from './apply-delta';
import { createTickTracker } from './tick-tracker';
import { realTimers } from './route-debouncer';

type Data = Record<string, unknown>;

/**
 * A fake grid that behaves like the SSRM where it matters: `update` replaces a row's data wholesale (so a partial
 * that was not merged first would lose fields), `add` inserts nodes, and every call is logged in order.
 */
class FakeGrid implements DeltaGridApi {
  nodes = new Map<string, IRowNode>();
  calls: string[] = [];
  transactions: ServerSideTransaction[] = [];
  scrollTop = 0;
  rowHeight = 28;
  rowCount = 0;
  applyServerSideTransaction = vi.fn((tx: ServerSideTransaction) => {
    this.calls.push(`tx:${(tx.route ?? []).join('|')}:${tx.add !== undefined ? 'add' : 'update'}`);
    this.transactions.push(structuredClone(tx));
    const added: IRowNode[] = [];
    for (const row of tx.add ?? []) {
      const node = this.node(this.idOf(row as Data), row as Data);
      added.push(node);
    }
    for (const row of tx.update ?? []) {
      const node = this.nodes.get(this.idOf(row as Data));
      if (node !== undefined) (node as { data: unknown }).data = row;
    }
    return { status: 'Applied', add: added } as never;
  });
  refreshServerSide = vi.fn();
  refreshCells = vi.fn((_params?: RefreshCellsParams) => undefined);
  setRowCount = vi.fn((count: number) => {
    this.rowCount = count;
  });
  ensureIndexVisible = vi.fn();
  getFirstDisplayedRowIndex = vi.fn(() => 0);
  getVerticalPixelRange = vi.fn(() => ({ top: this.scrollTop, bottom: this.scrollTop + 600 }));
  /** Id of the order at the top of the viewport, when a test wants the applier to anchor on it. */
  topId: string | undefined = undefined;
  getDisplayedRowAtIndex = vi.fn(() => ({ rowHeight: this.rowHeight, id: this.topId }));
  getRowNode = vi.fn((id: string): IRowNode | undefined => this.nodes.get(id));

  idOf(row: Data): string {
    return typeof row['orderId'] === 'string' ? row['orderId'] : `G:${String(row['pair'])}`;
  }
  node(id: string, data: Data): IRowNode {
    const node = { id, data } as unknown as IRowNode;
    this.nodes.set(id, node);
    return node;
  }
}

const delta = (patch: Partial<DeltaMsg> = {}): DeltaMsg => ({
  t: 'delta',
  seq: 1,
  serverTs: 1000,
  srcTs: 960,
  updates: [],
  groupUpdates: [],
  adds: [],
  dirtyRoutes: [],
  rowCounts: [],
  newAbove: 0,
  ...patch,
});

const PRICE = new Set(['marketMid', 'marketBid']);

const setup = (
  overrides: Partial<DeltaApplierOptions> = {},
): { grid: FakeGrid; applier: ReturnType<typeof createDeltaApplier>; ticks: ReturnType<typeof createTickTracker>; onNewAbove: ReturnType<typeof vi.fn> } => {
  const grid = new FakeGrid();
  const ticks = createTickTracker({ holdMs: 600, now: () => Date.now() });
  const onNewAbove = vi.fn();
  const applier = createDeltaApplier({
    api: grid,
    priceFields: PRICE,
    ticks,
    groupRowId: (route, row) => `G:${[...route, String(row['pair'])].join('|')}`,
    onNewAbove,
    timers: realTimers,
    ...overrides,
  });
  return { grid, applier, ticks, onNewAbove };
};

const newOrder = (orderId: string, extra: Data = {}): DeltaMsg['adds'][number]['rows'][number] =>
  ({ orderId, marketMid: 1, ...extra }) as DeltaMsg['adds'][number]['rows'][number];

describe('createDeltaApplier', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('adds and updates', () => {
    it('applies adds before updates, one synchronous transaction each', () => {
      const { grid, applier } = setup();
      grid.node('A', { orderId: 'A', marketMid: 1 });
      applier.apply(
        delta({
          updates: [{ route: [], rows: [{ orderId: 'A', marketMid: 2 }] }],
          adds: [{ route: [], addIndex: 0, rows: [newOrder('N1')] }],
        }),
      );
      expect(grid.calls).toEqual(['tx::add', 'tx::update']);
      expect(grid.transactions[0]).toMatchObject({ route: [], addIndex: 0, add: [{ orderId: 'N1' }] });
    });

    it('can update a row that the same delta added', () => {
      const { grid, applier } = setup();
      applier.apply(
        delta({
          adds: [{ route: [], addIndex: 0, rows: [newOrder('N1', { filledQty: 5 })] }],
          updates: [{ route: [], rows: [{ orderId: 'N1', marketMid: 3 }] }],
        }),
      );
      expect(grid.nodes.get('N1')?.data).toEqual({ orderId: 'N1', marketMid: 3, filledQty: 5 });
    });

    it('merges a partial into the current row data so no field is lost', () => {
      const { grid, applier } = setup();
      grid.node('A', { orderId: 'A', marketMid: 1, filledQty: 10, venue: 'EBS' });
      applier.apply(delta({ updates: [{ route: [], rows: [{ orderId: 'A', marketMid: 2 }] }] }));
      expect(grid.transactions[0]?.update).toEqual([{ orderId: 'A', marketMid: 2, filledQty: 10, venue: 'EBS' }]);
      expect(grid.nodes.get('A')?.data).toEqual({ orderId: 'A', marketMid: 2, filledQty: 10, venue: 'EBS' });
    });

    it('loses nothing across two deltas in a row that touch different fields', () => {
      const { grid, applier } = setup();
      grid.node('A', { orderId: 'A', marketMid: 1, filledQty: 10 });
      applier.apply(delta({ seq: 1, updates: [{ route: [], rows: [{ orderId: 'A', marketMid: 2 }] }] }));
      applier.apply(delta({ seq: 2, updates: [{ route: [], rows: [{ orderId: 'A', filledQty: 20 }] }] }));
      expect(grid.nodes.get('A')?.data).toEqual({ orderId: 'A', marketMid: 2, filledQty: 20 });
    });

    it('folds two partials for one row in the same delta', () => {
      const { grid, applier } = setup();
      grid.node('A', { orderId: 'A', marketMid: 1, filledQty: 10 });
      applier.apply(
        delta({
          updates: [{ route: [], rows: [{ orderId: 'A', marketMid: 2 }, { orderId: 'A', filledQty: 20 }] }],
        }),
      );
      expect(grid.transactions[0]?.update).toEqual([{ orderId: 'A', marketMid: 2, filledQty: 20 }]);
    });

    it('never uses the async transaction api', () => {
      const { grid, applier } = setup();
      grid.node('A', { orderId: 'A' });
      const asyncTx = vi.fn();
      (grid as unknown as { applyServerSideTransactionAsync: unknown }).applyServerSideTransactionAsync = asyncTx;
      applier.apply(delta({ updates: [{ route: [], rows: [{ orderId: 'A', marketMid: 2 }] }] }));
      expect(asyncTx).not.toHaveBeenCalled();
    });

    it('applies one transaction per route', () => {
      const { grid, applier } = setup();
      grid.node('A', { orderId: 'A', marketMid: 1 });
      grid.node('B', { orderId: 'B', marketMid: 1 });
      grid.node('C', { orderId: 'C', marketMid: 1 });
      applier.apply(
        delta({
          updates: [
            { route: ['EURUSD', 'LIVE'], rows: [{ orderId: 'A', marketMid: 2 }, { orderId: 'B', marketMid: 2 }] },
            { route: ['GBPUSD', 'LIVE'], rows: [{ orderId: 'C', marketMid: 2 }] },
          ],
        }),
      );
      expect(grid.transactions.map((t) => [t.route, t.update?.length])).toEqual([
        [['EURUSD', 'LIVE'], 2],
        [['GBPUSD', 'LIVE'], 1],
      ]);
    });

    it('skips rows the grid does not hold and makes no transaction when all are unknown', () => {
      const { grid, applier } = setup();
      grid.node('A', { orderId: 'A', marketMid: 1 });
      const stats = applier.apply(
        delta({ updates: [{ route: [], rows: [{ orderId: 'A', marketMid: 2 }, { orderId: 'GONE', marketMid: 2 }] }] }),
      );
      expect(grid.transactions[0]?.update).toHaveLength(1);
      expect(stats).toMatchObject({ rowsUpdated: 1, skipped: 1 });
      grid.applyServerSideTransaction.mockClear();
      const none = applier.apply(delta({ updates: [{ route: [], rows: [{ orderId: 'GONE', marketMid: 2 }] }] }));
      expect(grid.applyServerSideTransaction).not.toHaveBeenCalled();
      expect(none).toMatchObject({ rowsUpdated: 0, skipped: 1 });
    });

    it('skips a node that has no data yet (a loading row)', () => {
      const { grid, applier } = setup();
      grid.nodes.set('L', { id: 'L', data: undefined } as unknown as IRowNode);
      const stats = applier.apply(delta({ updates: [{ route: [], rows: [{ orderId: 'L', marketMid: 2 }] }] }));
      expect(stats.skipped).toBe(1);
      expect(grid.applyServerSideTransaction).not.toHaveBeenCalled();
    });

    it('counts added rows from the transaction result and ignores empty adds', () => {
      const { grid, applier } = setup();
      const stats = applier.apply(
        delta({
          adds: [
            { route: [], addIndex: 0, rows: [newOrder('N1'), newOrder('N2')] },
            { route: ['EURUSD'], addIndex: 0, rows: [] },
          ],
        }),
      );
      expect(stats.rowsAdded).toBe(2);
      expect(grid.applyServerSideTransaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('group updates', () => {
    it('merges group rows by group row id on the parent route', () => {
      const { grid, applier } = setup();
      grid.node('G:EURUSD', { pair: 'EURUSD', childCount: 5, notionalUsd: 100 });
      const stats = applier.apply(
        delta({ groupUpdates: [{ route: [], rows: [{ pair: 'EURUSD', childCount: 6 }] }] }),
      );
      expect(grid.transactions[0]).toEqual({ route: [], update: [{ pair: 'EURUSD', childCount: 6, notionalUsd: 100 }] });
      expect(stats.rowsUpdated).toBe(1);
    });

    it('uses the route as the parent keys of the group id and skips groups that are not loaded', () => {
      const groupRowId = vi.fn((route: readonly string[], row: Data) => `G:${[...route, String(row['pair'])].join('|')}`);
      const { grid, applier } = setup({ groupRowId });
      grid.node('G:EURUSD|LIVE', { pair: 'LIVE', childCount: 1 });
      const stats = applier.apply(
        delta({
          groupUpdates: [{ route: ['EURUSD'], rows: [{ pair: 'LIVE', childCount: 2 }, { pair: 'PAUSED', childCount: 9 }] }],
        }),
      );
      expect(groupRowId).toHaveBeenCalledWith(['EURUSD'], { pair: 'LIVE', childCount: 2 });
      expect(grid.transactions[0]?.update).toEqual([{ pair: 'LIVE', childCount: 2 }]);
      expect(stats).toMatchObject({ rowsUpdated: 1, skipped: 1 });
    });
  });

  describe('dirty routes', () => {
    it('refreshes a dirty route without purging, at most once per second per route', () => {
      const { grid, applier } = setup();
      applier.apply(delta({ dirtyRoutes: [['EURUSD', 'LIVE']] }));
      expect(grid.refreshServerSide).toHaveBeenCalledTimes(1);
      expect(grid.refreshServerSide).toHaveBeenLastCalledWith({ route: ['EURUSD', 'LIVE'], purge: false });
      for (let i = 0; i < 9; i += 1) {
        vi.advanceTimersByTime(100);
        applier.apply(delta({ dirtyRoutes: [['EURUSD', 'LIVE']] }));
      }
      expect(grid.refreshServerSide).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(100);
      expect(grid.refreshServerSide).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(5000);
      expect(grid.refreshServerSide).toHaveBeenCalledTimes(2);
    });

    it('refreshes different routes independently', () => {
      const { grid, applier } = setup();
      applier.apply(delta({ dirtyRoutes: [[], ['EURUSD']] }));
      expect(grid.refreshServerSide.mock.calls.map((c) => c[0])).toEqual([
        { route: [], purge: false },
        { route: ['EURUSD'], purge: false },
      ]);
    });

    it('honours a custom interval', () => {
      const { grid, applier } = setup({ refreshIntervalMs: 250 });
      applier.apply(delta({ dirtyRoutes: [[]] }));
      applier.apply(delta({ dirtyRoutes: [[]] }));
      vi.advanceTimersByTime(250);
      expect(grid.refreshServerSide).toHaveBeenCalledTimes(2);
    });
  });

  describe('row counts', () => {
    it('sets the root count and reports it, and leaves other routes to the dirty-route refresh', () => {
      const { grid, applier } = setup();
      const stats = applier.apply(
        delta({
          rowCounts: [
            { route: ['EURUSD'], rowCount: 7 },
            { route: [], rowCount: 1_000_100 },
          ],
        }),
      );
      expect(grid.setRowCount).toHaveBeenCalledTimes(1);
      expect(grid.setRowCount).toHaveBeenCalledWith(1_000_100);
      expect(stats.rootRowCount).toBe(1_000_100);
    });

    it('does not set the count while the host says it cannot (grouped rows), but still reports it', () => {
      const { grid, applier } = setup({ canSetRowCount: () => false });
      const stats = applier.apply(delta({ rowCounts: [{ route: [], rowCount: 21 }] }));
      expect(grid.setRowCount).not.toHaveBeenCalled();
      expect(stats.rootRowCount).toBe(21);
    });

    it('reports no root count when the delta has none', () => {
      const { grid, applier } = setup();
      expect(applier.apply(delta()).rootRowCount).toBeNull();
      expect(grid.setRowCount).not.toHaveBeenCalled();
    });
  });

  describe('up and down colouring', () => {
    it('records the direction of price changes against the previous value', () => {
      const { grid, applier, ticks } = setup();
      grid.node('A', { orderId: 'A', marketMid: 1.1, marketBid: 1.0, filledQty: 1 });
      applier.apply(delta({ updates: [{ route: [], rows: [{ orderId: 'A', marketMid: 1.2, marketBid: 0.9, filledQty: 2 }] }] }));
      expect(ticks.direction('A', 'marketMid')).toBe('up');
      expect(ticks.direction('A', 'marketBid')).toBe('down');
      expect(ticks.direction('A', 'filledQty')).toBeNull();
      expect(ticks.previous('A', 'marketMid')).toBe(1.1);
    });

    it('tracks the previous value across consecutive deltas', () => {
      const { grid, applier, ticks } = setup();
      grid.node('A', { orderId: 'A', marketMid: 1.1 });
      applier.apply(delta({ updates: [{ route: [], rows: [{ orderId: 'A', marketMid: 1.2 }] }] }));
      applier.apply(delta({ updates: [{ route: [], rows: [{ orderId: 'A', marketMid: 1.15 }] }] }));
      expect(ticks.direction('A', 'marketMid')).toBe('down');
      expect(ticks.previous('A', 'marketMid')).toBe(1.2);
    });

    it('leaves the colour alone when the price did not change', () => {
      const { grid, applier, ticks } = setup();
      grid.node('A', { orderId: 'A', marketMid: 1.1 });
      applier.apply(delta({ updates: [{ route: [], rows: [{ orderId: 'A', marketMid: 1.1 }] }] }));
      expect(ticks.size).toBe(0);
    });

    it('redraws only the expired price cells, after the hold window, without flashing them', () => {
      const { grid, applier, ticks } = setup();
      const node = grid.node('A', { orderId: 'A', marketMid: 1.1 });
      applier.apply(delta({ updates: [{ route: [], rows: [{ orderId: 'A', marketMid: 1.2 }] }] }));
      vi.advanceTimersByTime(500);
      expect(grid.refreshCells).not.toHaveBeenCalled();
      vi.advanceTimersByTime(200);
      expect(grid.refreshCells).toHaveBeenCalledTimes(1);
      expect(grid.refreshCells).toHaveBeenCalledWith({ rowNodes: [node], columns: ['marketMid'], force: true, suppressFlash: true });
      expect(ticks.size).toBe(0);
      vi.advanceTimersByTime(5000);
      expect(grid.refreshCells).toHaveBeenCalledTimes(1);
    });

    it('keeps a ticking cell coloured instead of redrawing it', () => {
      const { grid, applier } = setup();
      grid.node('A', { orderId: 'A', marketMid: 1 });
      for (let i = 1; i <= 10; i += 1) {
        applier.apply(delta({ updates: [{ route: [], rows: [{ orderId: 'A', marketMid: 1 + i / 100 }] }] }));
        vi.advanceTimersByTime(333);
      }
      expect(grid.refreshCells).not.toHaveBeenCalled();
    });
  });

  describe('new rows on top and anchoring', () => {
    const topAdd = (n: number): DeltaMsg['adds'] => [
      { route: [], addIndex: 0, rows: Array.from({ length: n }, (_, i) => newOrder(`N${String(i)}-${String(Math.random())}`)) },
    ];

    it('at the top the new rows simply appear: no scroll and no badge', () => {
      const { grid, applier, onNewAbove } = setup();
      grid.scrollTop = 0;
      applier.apply(delta({ adds: topAdd(3), newAbove: 3 }));
      expect(grid.ensureIndexVisible).not.toHaveBeenCalled();
      expect(onNewAbove).not.toHaveBeenCalled();
    });

    it('scrolled down, keeps the visible rows still and counts the new orders for the badge', () => {
      const { grid, applier, onNewAbove } = setup();
      grid.scrollTop = 200 * 28;
      applier.apply(delta({ adds: topAdd(3), newAbove: 3 }));
      expect(grid.ensureIndexVisible).toHaveBeenCalledWith(203, 'top');
      expect(onNewAbove).toHaveBeenCalledWith(3);
    });

    it('anchors on the row the probe reports, which is exact even where the scroll position is scaled', () => {
      const { grid, applier, onNewAbove } = setup({ topRowProbe: () => 600_000 });
      grid.scrollTop = 0;
      applier.apply(delta({ adds: topAdd(2), newAbove: 2 }));
      expect(grid.ensureIndexVisible).toHaveBeenCalledWith(600_002, 'top');
      expect(onNewAbove).toHaveBeenCalledWith(2);
    });

    it('reads the viewport before the rows are inserted', () => {
      const { grid, applier } = setup();
      grid.scrollTop = 100 * 28;
      const order: string[] = [];
      grid.getVerticalPixelRange.mockImplementation(() => {
        order.push('read');
        return { top: grid.scrollTop, bottom: grid.scrollTop + 600 };
      });
      grid.applyServerSideTransaction.mockImplementation(() => {
        order.push('tx');
        return { status: 'Applied', add: [{}] } as never;
      });
      applier.apply(delta({ adds: topAdd(1), newAbove: 1 }));
      expect(order.slice(0, 2)).toEqual(['read', 'tx']);
    });

    it('accumulates over deltas: each one moves the viewport by its own rows', () => {
      const { grid, applier, onNewAbove } = setup();
      grid.scrollTop = 50 * 28;
      applier.apply(delta({ adds: topAdd(2), newAbove: 2 }));
      applier.apply(delta({ adds: topAdd(5), newAbove: 5 }));
      expect(onNewAbove.mock.calls.map((c) => c[0])).toEqual([2, 5]);
    });

    it('does not read the viewport when nothing arrived on top', () => {
      const { grid, applier } = setup();
      grid.node('A', { orderId: 'A', marketMid: 1 });
      applier.apply(delta({ updates: [{ route: [], rows: [{ orderId: 'A', marketMid: 2 }] }] }));
      expect(grid.getVerticalPixelRange).not.toHaveBeenCalled();
    });

    it('ignores adds to a group route for anchoring', () => {
      const { grid, applier, onNewAbove } = setup();
      grid.scrollTop = 100 * 28;
      applier.apply(delta({ adds: [{ route: ['EURUSD', 'LIVE'], addIndex: 0, rows: [newOrder('N1')] }] }));
      expect(grid.ensureIndexVisible).not.toHaveBeenCalled();
      expect(onNewAbove).not.toHaveBeenCalled();
    });

    describe('when the new rows come with a background refresh (the Appendix F path)', () => {
      /** An order the user is reading at row `row`, which the grid will later report at another index. */
      const reading = (grid: FakeGrid, id: string, row: number): void => {
        grid.scrollTop = row * 28;
        grid.topId = id;
        grid.node(id, { orderId: id });
      };
      const moveTo = (grid: FakeGrid, id: string, rowIndex: number): void => {
        (grid.nodes.get(id) as { rowIndex?: number }).rowIndex = rowIndex;
      };

      it('anchors on the order being read when newAbove undercounts (the refresh ends on block 0)', () => {
        const { grid, applier, onNewAbove } = setup();
        reading(grid, 'X', 200);
        applier.apply(delta({ rowCounts: [{ route: [], rowCount: 1000 }] }));
        applier.onStoreRefreshed([]);
        applier.apply(delta({ newAbove: 1, dirtyRoutes: [[]], rowCounts: [{ route: [], rowCount: 1005 }] }));
        expect(onNewAbove).toHaveBeenCalledTimes(1);
        expect(onNewAbove).toHaveBeenLastCalledWith(1);

        moveTo(grid, 'X', 205);
        applier.onStoreRefreshed([]);
        expect(grid.ensureIndexVisible).toHaveBeenCalledWith(205, 'top');
        // The badge was already told about 1 row from newAbove; it learns about the other 4.
        expect(onNewAbove).toHaveBeenLastCalledWith(4);
        applier.onStoreRefreshed([]);
        expect(grid.ensureIndexVisible).toHaveBeenCalledTimes(1);
      });

      it('does not follow an order that moved without any rows arriving (a sort on a ticking column)', () => {
        const { grid, applier, onNewAbove } = setup();
        reading(grid, 'X', 200);
        applier.apply(delta({ rowCounts: [{ route: [], rowCount: 1000 }] }));
        applier.onStoreRefreshed([]);
        applier.apply(delta({ dirtyRoutes: [[]], rowCounts: [{ route: [], rowCount: 1000 }] }));
        moveTo(grid, 'X', 700);
        applier.onStoreRefreshed([]);
        expect(grid.ensureIndexVisible).not.toHaveBeenCalled();
        expect(onNewAbove).not.toHaveBeenCalled();
      });

      it('follows the order a little past the rows counted, for deltas still in flight', () => {
        const { grid, applier } = setup();
        reading(grid, 'X', 200);
        applier.apply(delta({ rowCounts: [{ route: [], rowCount: 1000 }] }));
        applier.onStoreRefreshed([]);
        applier.apply(delta({ dirtyRoutes: [[]], rowCounts: [{ route: [], rowCount: 1004 }] }));
        moveTo(grid, 'X', 205);
        applier.onStoreRefreshed([]);
        expect(grid.ensureIndexVisible).toHaveBeenCalledWith(205, 'top');
      });

      it('follows an order that moved up a few rows (rows left above it)', () => {
        const { grid, applier, onNewAbove } = setup();
        reading(grid, 'X', 200);
        applier.apply(delta({ rowCounts: [{ route: [], rowCount: 1000 }] }));
        applier.onStoreRefreshed([]);
        applier.apply(delta({ dirtyRoutes: [[]], rowCounts: [{ route: [], rowCount: 1000 }] }));
        moveTo(grid, 'X', 198);
        applier.onStoreRefreshed([]);
        expect(grid.ensureIndexVisible).toHaveBeenCalledWith(198, 'top');
        expect(onNewAbove).not.toHaveBeenCalled();
      });

      it('leaves alone an order that moved far more than the arrivals explain', () => {
        const { grid, applier } = setup();
        reading(grid, 'X', 200);
        applier.apply(delta({ rowCounts: [{ route: [], rowCount: 1000 }] }));
        applier.onStoreRefreshed([]);
        applier.apply(delta({ dirtyRoutes: [[]], rowCounts: [{ route: [], rowCount: 1003 }] }));
        moveTo(grid, 'X', 700);
        applier.onStoreRefreshed([]);
        expect(grid.ensureIndexVisible).not.toHaveBeenCalled();
      });

      it('counts the rows that arrived over several deltas since the previous refresh', () => {
        const { grid, applier } = setup();
        reading(grid, 'X', 200);
        applier.apply(delta({ rowCounts: [{ route: [], rowCount: 1000 }] }));
        applier.onStoreRefreshed([]);
        for (let count = 1001; count <= 1005; count += 1) {
          applier.apply(delta({ rowCounts: [{ route: [], rowCount: count }], dirtyRoutes: count === 1005 ? [[]] : [] }));
        }
        moveTo(grid, 'X', 205);
        applier.onStoreRefreshed([]);
        expect(grid.ensureIndexVisible).toHaveBeenCalledWith(205, 'top');
      });

      it('falls back to newAbove when the order is not loaded after the refresh', () => {
        const { grid, applier } = setup();
        reading(grid, 'X', 200);
        applier.apply(delta({ newAbove: 4, dirtyRoutes: [[]] }));
        grid.nodes.delete('X');
        applier.onStoreRefreshed([]);
        expect(grid.ensureIndexVisible).toHaveBeenCalledWith(204, 'top');
      });

      it('takes no snapshot at the top of the grid', () => {
        const { grid, applier } = setup();
        reading(grid, 'X', 0);
        applier.apply(delta({ dirtyRoutes: [[]], newAbove: 2 }));
        moveTo(grid, 'X', 2);
        applier.onStoreRefreshed([]);
        expect(grid.ensureIndexVisible).not.toHaveBeenCalled();
      });

      it('waits for the root store to refresh, then moves by newAbove from where the viewport is by then', () => {
        const { grid, applier, onNewAbove } = setup();
        grid.scrollTop = 200 * 28;
        applier.apply(delta({ newAbove: 4, dirtyRoutes: [[]] }));
        expect(grid.ensureIndexVisible).not.toHaveBeenCalled();
        expect(onNewAbove).toHaveBeenCalledWith(4);
        grid.scrollTop = 210 * 28;
        applier.onStoreRefreshed(undefined);
        expect(grid.ensureIndexVisible).toHaveBeenCalledWith(214, 'top');
        applier.onStoreRefreshed(undefined);
        expect(grid.ensureIndexVisible).toHaveBeenCalledTimes(1);
      });

      it('sums the rows of several deltas before the refresh lands', () => {
        const { grid, applier } = setup();
        grid.scrollTop = 100 * 28;
        applier.apply(delta({ newAbove: 2, dirtyRoutes: [[]] }));
        applier.apply(delta({ newAbove: 3 }));
        applier.onStoreRefreshed([]);
        expect(grid.ensureIndexVisible).toHaveBeenCalledWith(105, 'top');
      });

      it('ignores the refresh of a group route and does nothing when nothing is pending', () => {
        const { grid, applier } = setup();
        grid.scrollTop = 100 * 28;
        applier.onStoreRefreshed(undefined);
        applier.apply(delta({ newAbove: 2, dirtyRoutes: [[]] }));
        applier.onStoreRefreshed(['EURUSD']);
        expect(grid.ensureIndexVisible).not.toHaveBeenCalled();
      });

      it('does not scroll if the user has meanwhile returned to the top', () => {
        const { grid, applier } = setup();
        grid.scrollTop = 100 * 28;
        applier.apply(delta({ newAbove: 2, dirtyRoutes: [[]] }));
        grid.scrollTop = 0;
        applier.onStoreRefreshed(undefined);
        expect(grid.ensureIndexVisible).not.toHaveBeenCalled();
      });
    });
  });

  describe('reset', () => {
    it('forgets previous values, pending refreshes, pending anchors and the colour sweep', () => {
      const { grid, applier, ticks } = setup();
      grid.node('A', { orderId: 'A', marketMid: 1 });
      grid.scrollTop = 100 * 28;
      applier.apply(delta({ updates: [{ route: [], rows: [{ orderId: 'A', marketMid: 2 }] }], dirtyRoutes: [[]], newAbove: 2 }));
      applier.apply(delta({ dirtyRoutes: [[]] }));
      expect(grid.refreshServerSide).toHaveBeenCalledTimes(1);
      applier.reset();
      expect(ticks.size).toBe(0);
      vi.advanceTimersByTime(5000);
      expect(grid.refreshServerSide).toHaveBeenCalledTimes(1);
      expect(grid.refreshCells).not.toHaveBeenCalled();
      applier.onStoreRefreshed(undefined);
      expect(grid.ensureIndexVisible).not.toHaveBeenCalled();
      // And it starts afresh: the next request for the route runs at once.
      applier.apply(delta({ dirtyRoutes: [[]] }));
      expect(grid.refreshServerSide).toHaveBeenCalledTimes(2);
    });

    it('dispose does the same', () => {
      const { grid, applier } = setup();
      applier.apply(delta({ dirtyRoutes: [[]] }));
      applier.apply(delta({ dirtyRoutes: [[]] }));
      applier.dispose();
      vi.advanceTimersByTime(5000);
      expect(grid.refreshServerSide).toHaveBeenCalledTimes(1);
    });
  });
});
