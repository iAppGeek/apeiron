import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppController } from '../state/app-controller';
import { resetAppStore, useAppStore } from '../state/app-store';
import type { BlotterClient, ClientEvents } from '../transport/client';
import { createDeltaApplier, type DeltaApplier, type DeltaApplierOptions } from './apply-delta';
import { Blotter } from './Blotter';

type FakeApi = {
  setGridOption: ReturnType<typeof vi.fn>;
  refreshServerSide: ReturnType<typeof vi.fn>;
  ensureIndexVisible: ReturnType<typeof vi.fn>;
  getVerticalPixelRange: ReturnType<typeof vi.fn>;
  getFirstDisplayedRowIndex: ReturnType<typeof vi.fn>;
  getDisplayedRowAtIndex: ReturnType<typeof vi.fn>;
  getRowGroupColumns: ReturnType<typeof vi.fn>;
};

const grid = vi.hoisted(() => ({ props: null as Record<string, unknown> | null, api: null as unknown }));

vi.mock('ag-grid-react', async () => {
  const React = await import('react');
  return {
    AgGridProvider: ({ children }: { children: ReactNode }): ReactElement => React.createElement(React.Fragment, null, children),
    AgGridReact: (props: Record<string, unknown>): ReactElement => {
      grid.props = props;
      React.useEffect(() => {
        (props['onGridReady'] as (e: { api: unknown }) => void)({ api: grid.api });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return React.createElement('div', { 'data-testid': 'grid' });
    },
  };
});
vi.mock('./apply-delta', () => ({ createDeltaApplier: vi.fn() }));

type FakeApplier = { [K in keyof DeltaApplier]: ReturnType<typeof vi.fn> };
const stats = { rowsUpdated: 2, rowsAdded: 0, skipped: 0, rootRowCount: null };
const makeApplier = (): FakeApplier => ({
  apply: vi.fn(() => stats),
  onStoreRefreshed: vi.fn(),
  reset: vi.fn(),
  dispose: vi.fn(),
});

type Handlers = { [E in keyof ClientEvents]?: (payload: ClientEvents[E]) => void };

const makeClient = (): { client: BlotterClient; handlers: Handlers; off: ReturnType<typeof vi.fn> } => {
  const handlers: Handlers = {};
  const off = vi.fn();
  const client = {
    on: (event: keyof ClientEvents, handler: never): (() => void) => {
      (handlers as Record<string, unknown>)[event] = handler;
      return off;
    },
    getRows: vi.fn(),
    setFilterValues: vi.fn(),
  } as unknown as BlotterClient;
  return { client, handlers, off };
};

const makeController = (): {
  controller: AppController;
  setPurge: ReturnType<typeof vi.fn>;
  setDeltaHandler: ReturnType<typeof vi.fn>;
} => {
  const setPurge = vi.fn();
  const setDeltaHandler = vi.fn();
  return { controller: { setPurge, setDeltaHandler } as unknown as AppController, setPurge, setDeltaHandler };
};

describe('Blotter', () => {
  let api: FakeApi;
  let applier: FakeApplier;
  beforeEach(() => {
    resetAppStore();
    api = {
      setGridOption: vi.fn(),
      refreshServerSide: vi.fn(),
      ensureIndexVisible: vi.fn(),
      getVerticalPixelRange: vi.fn(() => ({ top: 0, bottom: 600 })),
      getFirstDisplayedRowIndex: vi.fn(() => 0),
      getDisplayedRowAtIndex: vi.fn(() => ({ rowHeight: 28 })),
      getRowGroupColumns: vi.fn(() => []),
    };
    grid.api = api;
    grid.props = null;
    applier = makeApplier();
    vi.mocked(createDeltaApplier).mockReset();
    vi.mocked(createDeltaApplier).mockReturnValue(applier as unknown as DeltaApplier);
  });

  it('configures the grid as the plan specifies', () => {
    const { client } = makeClient();
    render(<Blotter client={client} controller={makeController().controller} />);
    expect(grid.props).toMatchObject({
      rowModelType: 'serverSide',
      cacheBlockSize: 100,
      maxBlocksInCache: 20,
      rowGroupPanelShow: 'always',
      animateRows: false,
      rowBuffer: 10,
      sideBar: { toolPanels: ['columns', 'filters'] },
    });
    expect(Object.keys(grid.props?.['aggFuncs'] as object)).toEqual(['wavg']);
    expect(grid.props?.['columnDefs']).toHaveLength(50);
    expect(typeof grid.props?.['getRowId']).toBe('function');
  });

  it('shows the connecting overlay and sets no datasource until the server said welcome', () => {
    const { client } = makeClient();
    render(<Blotter client={client} controller={makeController().controller} />);
    expect(screen.getByRole('status')).toHaveTextContent('Connecting to server');
    expect(api.setGridOption).not.toHaveBeenCalled();
  });

  it('shows a reconnecting message while the link is down before welcome', () => {
    useAppStore.getState().setStatus('reconnecting', 2);
    const { client } = makeClient();
    render(<Blotter client={client} controller={makeController().controller} />);
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting to server');
  });

  it('sets the server-side datasource once welcomed, and shows Loading orders while the server is not ready', () => {
    const { client } = makeClient();
    render(<Blotter client={client} controller={makeController().controller} />);
    act(() => {
      useAppStore.getState().setWelcomed([]);
    });
    expect(api.setGridOption).toHaveBeenCalledWith('serverSideDatasource', expect.objectContaining({ getRows: expect.any(Function) }));
    expect(screen.queryByRole('status')).toBeNull();
    act(() => {
      useAppStore.getState().setNotReady(true);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Loading orders');
  });

  it('turns on cell flash for every column, with the flash and fade durations', () => {
    const { client } = makeClient();
    render(<Blotter client={client} controller={makeController().controller} />);
    expect(grid.props?.['defaultColDef']).toMatchObject({ enableCellChangeFlash: true });
    expect(grid.props).toMatchObject({ cellFlashDuration: 600, cellFadeDuration: 400 });
  });

  it('gives the price columns up and down class rules and no other column', () => {
    const { client } = makeClient();
    render(<Blotter client={client} controller={makeController().controller} />);
    const defs = grid.props?.['columnDefs'] as { field: string; cellClassRules?: Record<string, unknown> }[];
    const price = defs.filter((d) => d.cellClassRules !== undefined).map((d) => d.field);
    expect(price.length).toBeGreaterThan(0);
    expect(price).toContain('marketMid');
    expect(price).not.toContain('orderQty');
    expect(Object.keys(defs.find((d) => d.field === 'marketMid')?.cellClassRules ?? {})).toEqual(['tick-up', 'tick-down']);
  });

  it('registers a purge that resets the live state, clears the badge and refreshes the whole cache, and unregisters on unmount', () => {
    const { client } = makeClient();
    const { controller, setPurge } = makeController();
    const { unmount } = render(<Blotter client={client} controller={controller} />);
    useAppStore.getState().addNewOrders(4);
    const purge = setPurge.mock.calls[0]?.[0] as () => void;
    purge();
    expect(applier.reset).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().newOrders).toBe(0);
    expect(api.refreshServerSide).toHaveBeenCalledWith({ purge: true });
    unmount();
    expect(setPurge).toHaveBeenLastCalledWith(null);
  });

  it('registers a delta handler that applies deltas to the grid and returns the stats, and removes it on unmount', () => {
    const { client } = makeClient();
    const { controller, setDeltaHandler } = makeController();
    const { unmount } = render(<Blotter client={client} controller={controller} />);
    const handler = setDeltaHandler.mock.calls[0]?.[0] as (d: unknown) => unknown;
    const delta = { t: 'delta', seq: 1 };
    expect(handler(delta)).toBe(stats);
    expect(applier.apply).toHaveBeenCalledWith(delta);
    unmount();
    expect(setDeltaHandler).toHaveBeenLastCalledWith(null);
    expect(applier.dispose).toHaveBeenCalledTimes(1);
  });

  it('creates the applier for the real grid api with the price fields and a badge callback', () => {
    const { client } = makeClient();
    render(<Blotter client={client} controller={makeController().controller} />);
    const options = vi.mocked(createDeltaApplier).mock.calls[0]?.[0] as DeltaApplierOptions;
    expect(options.api).toBe(api);
    expect(options.priceFields.has('marketMid')).toBe(true);
    expect(options.priceFields.has('orderQty')).toBe(false);
    options.onNewAbove?.(3);
    expect(useAppStore.getState().newOrders).toBe(3);
  });

  it('builds group row ids from the active row group columns', () => {
    const { client } = makeClient();
    api.getRowGroupColumns.mockReturnValue([{ getColDef: () => ({ field: 'pair' }) }, { getColDef: () => ({ field: 'status' }) }]);
    render(<Blotter client={client} controller={makeController().controller} />);
    const options = vi.mocked(createDeltaApplier).mock.calls[0]?.[0] as DeltaApplierOptions;
    expect(options.groupRowId([], { pair: 'EURUSD' })).toBe('G:EURUSD');
    expect(options.groupRowId(['EURUSD'], { status: 'LIVE' })).toBe('G:EURUSD|LIVE');
  });

  it('lets the applier set the row count only while rows are not grouped', () => {
    const { client } = makeClient();
    render(<Blotter client={client} controller={makeController().controller} />);
    const options = vi.mocked(createDeltaApplier).mock.calls[0]?.[0] as DeltaApplierOptions;
    expect(options.canSetRowCount?.()).toBe(true);
    api.getRowGroupColumns.mockReturnValue([{ getColDef: () => ({ field: 'pair' }) }]);
    expect(options.canSetRowCount?.()).toBe(false);
  });

  it('tells the applier when a store has refreshed', () => {
    const { client } = makeClient();
    render(<Blotter client={client} controller={makeController().controller} />);
    (grid.props?.['onStoreRefreshed'] as (e: { route?: string[] }) => void)({ route: ['EURUSD'] });
    expect(applier.onStoreRefreshed).toHaveBeenCalledWith(['EURUSD']);
  });

  describe('new orders badge', () => {
    it('is hidden at zero and shows the count when new orders arrived above the viewport', () => {
      const { client } = makeClient();
      render(<Blotter client={client} controller={makeController().controller} />);
      expect(screen.queryByTestId('new-orders-badge')).toBeNull();
      act(() => {
        useAppStore.getState().addNewOrders(7);
      });
      expect(screen.getByTestId('new-orders-badge')).toHaveTextContent('7 new orders ↑');
    });

    it('scrolls to the top and clears the count when clicked', async () => {
      const { client } = makeClient();
      render(<Blotter client={client} controller={makeController().controller} />);
      act(() => {
        useAppStore.getState().addNewOrders(7);
      });
      await userEvent.click(screen.getByTestId('new-orders-badge'));
      expect(api.ensureIndexVisible).toHaveBeenCalledWith(0, 'top');
      expect(useAppStore.getState().newOrders).toBe(0);
      expect(screen.queryByTestId('new-orders-badge')).toBeNull();
    });

    it('clears when the user scrolls back to the top, and not while still scrolled down', () => {
      const { client } = makeClient();
      render(<Blotter client={client} controller={makeController().controller} />);
      useAppStore.getState().addNewOrders(2);
      const onBodyScroll = grid.props?.['onBodyScroll'] as (e: { direction: string }) => void;
      api.getVerticalPixelRange.mockReturnValue({ top: 28 * 50, bottom: 28 * 50 + 600 });
      onBodyScroll({ direction: 'vertical' });
      expect(useAppStore.getState().newOrders).toBe(2);
      onBodyScroll({ direction: 'horizontal' });
      expect(useAppStore.getState().newOrders).toBe(2);
      api.getVerticalPixelRange.mockReturnValue({ top: 0, bottom: 600 });
      onBodyScroll({ direction: 'vertical' });
      expect(useAppStore.getState().newOrders).toBe(0);
    });

    it('does not read the viewport on scroll when there is no badge', () => {
      const { client } = makeClient();
      render(<Blotter client={client} controller={makeController().controller} />);
      (grid.props?.['onBodyScroll'] as (e: { direction: string }) => void)({ direction: 'vertical' });
      expect(api.getVerticalPixelRange).not.toHaveBeenCalled();
    });
  });
});
