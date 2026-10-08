import { COLUMNS, type CommandAction } from '@apeiron/logos';
import type {
  BodyScrollEvent,
  DefaultMenuItem,
  GetContextMenuItemsParams,
  GridApi,
  GridReadyEvent,
  MenuItemDef,
  StoreRefreshedEvent,
} from 'ag-grid-community';
import { AgGridProvider, AgGridReact } from 'ag-grid-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { NewOrdersBadge } from '../components/NewOrdersBadge';
import type { AppController } from '../state/app-controller';
import { useAppStore } from '../state/app-store';
import { RequestError, type BlotterClient } from '../transport/client';
import { ROW_BUFFER, readTopRow } from './anchor';
import { createDeltaApplier, type DeltaApplier } from './apply-delta';
import { buildColumnDefs } from './column-defs';
import { createDatasource } from './datasource';
import type { BlotterContext } from './cell-renderers';
import { describeCommandFailure, describeFailure } from './errors';
import { fetchFilterValues } from './filter-values';
import { computeRowId, getRowId } from './get-row-id';
import {
  CACHE_BLOCK_SIZE,
  CELL_FADE_MS,
  CELL_FLASH_MS,
  TICK_HOLD_MS,
  MAX_BLOCKS_IN_CACHE,
  aggFuncs,
  autoGroupColumnDef,
  defaultColDef,
  sideBar,
  theme,
} from './grid-options';
import { GRID_MODULES } from './modules';
import { buildContextMenuItems, orderTargetOf } from './order-actions';
import { createPendingCommands } from './pending-commands';
import { createTickTracker } from './tick-tracker';
import { installTestHooks, noteDelta, notePurge, noteRequest } from '../testing/hooks-gate';
import { readFirstVisibleRow } from './viewport-probe';

export type BlotterProps = {
  client: BlotterClient;
  controller: AppController;
};

const wallClock = (): number => Date.now();

const PRICE_FIELDS: ReadonlySet<string> = new Set(COLUMNS.filter((c) => c.priceColumn === true).map((c) => c.field));

/** The badge reads its own slice of the store, so a new-order count ticking up does not re-render the grid. */
function NewOrdersBadgeConnected({ api }: { api: GridApi | null }): ReactElement {
  const count = useAppStore((s) => s.newOrders);
  return (
    <NewOrdersBadge
      count={count}
      onClick={() => {
        api?.ensureIndexVisible(0, 'top');
        useAppStore.getState().clearNewOrders();
      }}
    />
  );
}

export function Blotter({ client, controller }: BlotterProps): ReactElement {
  const [api, setApi] = useState<GridApi | null>(null);
  const applier = useRef<DeltaApplier | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const probe = useCallback((): number | null => readFirstVisibleRow(root.current), []);
  const ticks = useMemo(() => createTickTracker({ holdMs: TICK_HOLD_MS, now: wallClock }), []);
  const pending = useMemo(() => createPendingCommands(), []);
  const gridContext = useMemo<BlotterContext>(() => ({ isPending: (orderId) => pending.has(orderId) }), [pending]);
  const welcomed = useAppStore((s) => s.welcomed);
  const notReady = useAppStore((s) => s.notReady);
  const status = useAppStore((s) => s.status);

  const columnDefs = useMemo(
    () =>
      buildColumnDefs(COLUMNS, {
        fetchFilterValues: (colId) => fetchFilterValues(client, colId),
        tickDirection: (rowId, field) => ticks.direction(rowId, field),
      }),
    [client, ticks],
  );

  // Redraw the status cell of an order when a command on it starts or finishes.
  useEffect(() => {
    if (api === null) return undefined;
    return pending.subscribe((orderId) => {
      const node = api.getRowNode(orderId);
      if (node !== undefined) api.refreshCells({ rowNodes: [node], columns: ['status'], force: true });
    });
  }, [api, pending]);

  const runCommand = useCallback(
    (orderId: string, action: CommandAction): void => {
      pending.begin(orderId);
      client
        .command(orderId, action)
        .catch((error: unknown) => {
          const failure =
            error instanceof RequestError ? { code: error.code, message: error.message } : { code: 'INTERNAL' as const, message: '' };
          useAppStore.getState().pushToast('error', describeCommandFailure(failure.code, action, orderId, failure.message));
        })
        .finally(() => {
          pending.end(orderId);
        });
    },
    [client, pending],
  );

  const getContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams): (DefaultMenuItem | MenuItemDef)[] => buildContextMenuItems(orderTargetOf(params.node), runCommand),
    [runCommand],
  );

  const onGridReady = useCallback((event: GridReadyEvent) => {
    setApi(event.api);
  }, []);

  // The datasource is created once the server has accepted our hello, so the first blocks are not wasted.
  useEffect(() => {
    if (api === null || !welcomed) return undefined;
    const store = useAppStore.getState();
    api.setGridOption(
      'serverSideDatasource',
      createDatasource({
        client: {
          getRows: (request) => {
            noteRequest(request);
            return client.getRows(request);
          },
        },
        onRootRowCount: (count, grouped) => {
          store.setRowCount(count, grouped);
        },
        onNotReady: store.setNotReady,
        onError: ({ code, message }) => {
          store.pushToast('error', describeFailure(code, message));
        },
      }),
    );
    return undefined;
  }, [api, welcomed, client]);

  useEffect(() => {
    if (api === null) return undefined;
    const live = createDeltaApplier({
      api,
      priceFields: PRICE_FIELDS,
      ticks,
      groupRowId: (route, row) =>
        computeRowId({
          data: row,
          parentKeys: route,
          level: route.length,
          groupFields: api.getRowGroupColumns().map((col) => col.getColDef().field),
        }),
      onNewAbove: (count) => {
        useAppStore.getState().addNewOrders(count);
      },
      topRowProbe: probe,
      canSetRowCount: () => api.getRowGroupColumns().length === 0,
    });
    applier.current = live;
    const removeHooks = installTestHooks(api, () => client.pending());
    controller.setDeltaHandler((delta) => {
      const stats = live.apply(delta);
      noteDelta(stats);
      return stats;
    });
    // A purge starts over: forget previous values, pending refreshes and the new-orders badge, then reload.
    controller.setPurge(() => {
      notePurge();
      live.reset();
      live.beginReload();
      useAppStore.getState().clearNewOrders();
      api.refreshServerSide({ purge: true });
    });
    return (): void => {
      removeHooks();
      controller.setPurge(null);
      controller.setDeltaHandler(null);
      live.dispose();
      applier.current = null;
    };
  }, [api, controller, ticks, probe, client]);

  const onStoreRefreshed = useCallback((event: StoreRefreshedEvent) => {
    applier.current?.onStoreRefreshed(event.route);
  }, []);

  // Back at the top by scrolling: nothing is hidden above the viewport any more.
  const onBodyScroll = useCallback(
    (event: BodyScrollEvent) => {
      if (api === null || event.direction !== 'vertical' || useAppStore.getState().newOrders === 0) return;
      if (readTopRow(api, probe) === 0) useAppStore.getState().clearNewOrders();
    },
    [api, probe],
  );

  const overlay = !welcomed
    ? status === 'reconnecting'
      ? 'Reconnecting to server…'
      : 'Connecting to server…'
    : notReady
      ? 'Loading orders…'
      : null;

  return (
    <div className="blotter" ref={root} data-testid="blotter">
      <AgGridProvider modules={GRID_MODULES}>
        <AgGridReact
          theme={theme}
          rowModelType="serverSide"
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          autoGroupColumnDef={autoGroupColumnDef}
          aggFuncs={aggFuncs}
          getRowId={getRowId}
          cacheBlockSize={CACHE_BLOCK_SIZE}
          maxBlocksInCache={MAX_BLOCKS_IN_CACHE}
          blockLoadDebounceMillis={60}
          rowGroupPanelShow="always"
          suppressAggFuncInHeader
          // Rows shift constantly as orders arrive on top; animating each shift leaves ghost rows overlapping.
          animateRows={false}
          rowBuffer={ROW_BUFFER}
          cellFlashDuration={CELL_FLASH_MS}
          cellFadeDuration={CELL_FADE_MS}
          onStoreRefreshed={onStoreRefreshed}
          onBodyScroll={onBodyScroll}
          sideBar={sideBar}
          context={gridContext}
          getContextMenuItems={getContextMenuItems}
          onGridReady={onGridReady}
        />
      </AgGridProvider>
      <NewOrdersBadgeConnected api={api} />
      {overlay !== null && (
        <div className="overlay" role="status" data-testid="blotter-overlay">
          <div className="overlay-card">
            <span className="spinner" aria-hidden="true" />
            {overlay}
          </div>
        </div>
      )}
    </div>
  );
}
