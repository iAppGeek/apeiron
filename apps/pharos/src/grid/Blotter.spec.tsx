import type { ServerMsg } from '@apeiron/logos';
import { act, render, screen } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppController } from '../state/app-controller';
import { resetAppStore, useAppStore } from '../state/app-store';
import type { BlotterClient, ClientEvents } from '../transport/client';
import { applyDelta } from './apply-delta';
import { Blotter } from './Blotter';

type FakeApi = { setGridOption: ReturnType<typeof vi.fn>; refreshServerSide: ReturnType<typeof vi.fn> };

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
vi.mock('./apply-delta', () => ({ applyDelta: vi.fn() }));

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

const makeController = (): { controller: AppController; setPurge: ReturnType<typeof vi.fn> } => {
  const setPurge = vi.fn();
  return { controller: { setPurge } as unknown as AppController, setPurge };
};

describe('Blotter', () => {
  let api: FakeApi;
  beforeEach(() => {
    resetAppStore();
    api = { setGridOption: vi.fn(), refreshServerSide: vi.fn() };
    grid.api = api;
    grid.props = null;
    vi.mocked(applyDelta).mockClear();
  });

  it('configures the grid as the plan specifies', () => {
    const { client } = makeClient();
    render(<Blotter client={client} controller={makeController().controller} />);
    expect(grid.props).toMatchObject({
      rowModelType: 'serverSide',
      cacheBlockSize: 100,
      maxBlocksInCache: 20,
      rowGroupPanelShow: 'always',
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

  it('registers a purge that refreshes the whole server-side cache, and unregisters on unmount', () => {
    const { client } = makeClient();
    const { controller, setPurge } = makeController();
    const { unmount } = render(<Blotter client={client} controller={controller} />);
    const purge = setPurge.mock.calls[0]?.[0] as () => void;
    purge();
    expect(api.refreshServerSide).toHaveBeenCalledWith({ purge: true });
    unmount();
    expect(setPurge).toHaveBeenLastCalledWith(null);
  });

  it('hands delta messages to applyDelta and ignores other messages', () => {
    const { client, handlers } = makeClient();
    render(<Blotter client={client} controller={makeController().controller} />);
    const delta: ServerMsg = { t: 'delta', seq: 1, serverTs: 1, updates: [], groupUpdates: [], adds: [], dirtyRoutes: [], rowCounts: [], newAbove: 0 };
    handlers.message?.(delta);
    handlers.message?.({ t: 'ack', reqId: 1 });
    expect(applyDelta).toHaveBeenCalledTimes(1);
    expect(applyDelta).toHaveBeenCalledWith(api, delta);
  });
});
