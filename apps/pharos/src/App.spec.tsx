import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { resetAppStore, useAppStore } from './state/app-store';
import type { BlotterClient, ClientEvents } from './transport/client';
import type { WelcomeMsg } from './transport/messages';

vi.mock('./grid/Blotter', () => ({
  Blotter: (): ReactElement => <div data-testid="blotter" />,
}));

const welcome: WelcomeMsg = {
  t: 'welcome',
  serverTime: 1,
  traders: [
    { traderId: 'T1', traderName: 'Alice' },
    { traderId: 'T2', traderName: 'Ben' },
  ],
  columnsVersion: 'v',
};

type Handlers = { [E in keyof ClientEvents]?: (payload: ClientEvents[E]) => void };
const makeClient = (): { client: BlotterClient; handlers: Handlers; hello: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> } => {
  const handlers: Handlers = {};
  const hello = vi.fn().mockResolvedValue(welcome);
  const connect = vi.fn();
  const client = {
    on: (event: keyof ClientEvents, handler: never): (() => void) => {
      (handlers as Record<string, unknown>)[event] = handler;
      return () => undefined;
    },
    connect,
    hello,
    getRows: vi.fn(),
    setFilterValues: vi.fn(),
    dispose: vi.fn(),
  } as unknown as BlotterClient;
  return { client, handlers, hello, connect };
};

describe('App', () => {
  beforeEach(() => {
    resetAppStore();
  });

  it('connects to the websocket endpoint and says hello', () => {
    const { client, connect, hello } = makeClient();
    render(<App client={client} wsUrl="ws://host/ws" />);
    expect(connect).toHaveBeenCalledWith('ws://host/ws');
    expect(hello).toHaveBeenCalledWith('ALL', 'json');
    expect(screen.getByText('Apeiron')).toBeInTheDocument();
    expect(screen.getByTestId('blotter')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Status bar' })).toBeInTheDocument();
  });

  it('fills the trader list from the welcome and changes trader through hello', async () => {
    const { client, handlers, hello } = makeClient();
    render(<App client={client} wsUrl="ws://host/ws" />);
    handlers.message?.(welcome);
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Alice' })).toBeInTheDocument();
    });
    await userEvent.selectOptions(screen.getByRole('combobox'), 'T2');
    await waitFor(() => {
      expect(hello).toHaveBeenLastCalledWith('T2', 'json');
    });
    await waitFor(() => {
      expect(useAppStore.getState().confirmedTrader).toBe('T2');
    });
  });

  it('switches codec from the Dev menu by re-sending hello', async () => {
    const { client, handlers, hello } = makeClient();
    render(<App client={client} wsUrl="ws://host/ws" />);
    handlers.message?.(welcome);
    await userEvent.click(screen.getByRole('button', { name: 'Dev' }));
    await userEvent.click(await screen.findByRole('radio', { name: 'MessagePack' }));
    await waitFor(() => {
      expect(hello).toHaveBeenLastCalledWith('ALL', 'msgpack');
    });
    await waitFor(() => {
      expect(screen.getByTestId('status-codec')).toHaveTextContent('msgpack');
    });
  });

  it('shows connection state and stats from the client in the status bar', () => {
    const { client, handlers } = makeClient();
    render(<App client={client} wsUrl="ws://host/ws" />);
    handlers.status?.({ status: 'connected', attempt: 0, codec: 'json' });
    handlers.stats?.({ msgsIn: 4, msgsOut: 1, rttMs: 12 });
    useAppStore.getState().setRowCount(1_000_000);
    return waitFor(() => {
      expect(screen.getByTestId('status-connection')).toHaveTextContent('Connected');
      expect(screen.getByTestId('status-rtt')).toHaveTextContent('12 ms');
      expect(screen.getByTestId('status-rows')).toHaveTextContent('1,000,000');
    });
  });

  it('shows error toasts', async () => {
    const { client } = makeClient();
    render(<App client={client} wsUrl="ws://host/ws" />);
    useAppStore.getState().pushToast('error', 'Something failed');
    expect(await screen.findByRole('alert')).toHaveTextContent('Something failed');
  });
});
