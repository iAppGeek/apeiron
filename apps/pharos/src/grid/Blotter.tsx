import { COLUMNS } from '@apeiron/logos';
import type { GridApi, GridReadyEvent } from 'ag-grid-community';
import { AgGridProvider, AgGridReact } from 'ag-grid-react';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import type { AppController } from '../state/app-controller';
import { useAppStore } from '../state/app-store';
import type { BlotterClient } from '../transport/client';
import { applyDelta } from './apply-delta';
import { buildColumnDefs } from './column-defs';
import { createDatasource } from './datasource';
import { describeFailure } from './errors';
import { fetchFilterValues } from './filter-values';
import { getRowId } from './get-row-id';
import {
  CACHE_BLOCK_SIZE,
  MAX_BLOCKS_IN_CACHE,
  aggFuncs,
  autoGroupColumnDef,
  defaultColDef,
  getChildCount,
  sideBar,
  theme,
} from './grid-options';
import { GRID_MODULES } from './modules';

export type BlotterProps = {
  client: BlotterClient;
  controller: AppController;
};

export function Blotter({ client, controller }: BlotterProps): ReactElement {
  const [api, setApi] = useState<GridApi | null>(null);
  const welcomed = useAppStore((s) => s.welcomed);
  const notReady = useAppStore((s) => s.notReady);
  const status = useAppStore((s) => s.status);

  const columnDefs = useMemo(
    () => buildColumnDefs(COLUMNS, { fetchFilterValues: (colId) => fetchFilterValues(client, colId) }),
    [client],
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
        client,
        onRootRowCount: store.setRowCount,
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
    controller.setPurge(() => {
      api.refreshServerSide({ purge: true });
    });
    const off = client.on('message', (msg) => {
      if (msg.t === 'delta') applyDelta(api, msg);
    });
    return (): void => {
      controller.setPurge(null);
      off();
    };
  }, [api, client, controller]);

  const overlay = !welcomed
    ? status === 'reconnecting'
      ? 'Reconnecting to server…'
      : 'Connecting to server…'
    : notReady
      ? 'Loading orders…'
      : null;

  return (
    <div className="blotter">
      <AgGridProvider modules={GRID_MODULES}>
        <AgGridReact
          theme={theme}
          rowModelType="serverSide"
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          autoGroupColumnDef={autoGroupColumnDef}
          aggFuncs={aggFuncs}
          getRowId={getRowId}
          getChildCount={getChildCount}
          cacheBlockSize={CACHE_BLOCK_SIZE}
          maxBlocksInCache={MAX_BLOCKS_IN_CACHE}
          blockLoadDebounceMillis={60}
          rowGroupPanelShow="always"
          suppressAggFuncInHeader
          sideBar={sideBar}
          onGridReady={onGridReady}
        />
      </AgGridProvider>
      {overlay !== null && (
        <div className="overlay" role="status">
          <div className="overlay-card">
            <span className="spinner" aria-hidden="true" />
            {overlay}
          </div>
        </div>
      )}
    </div>
  );
}
