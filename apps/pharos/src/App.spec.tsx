import { act, render, screen, waitFor } from '@testing-library/react';
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
  preset: null,
};

type Handlers = { [E in keyof ClientEvents]?: (payload: ClientEvents[E]) => void };
const makeClient = (): {
  client: BlotterClient;
  handlers: Handlers;
  hello: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  control: ReturnType<typeof vi.fn>;
} => {
  const handlers: Handlers = {};
  const control = vi.fn().mockResolvedValue(undefined);
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
    control,
    dispose: vi.fn(),
  } as unknown as BlotterClient;
  return { client, handlers, hello, connect, control };
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
    handlers.status?.({ status: 'connected', attempt: 0, codec: 'json', reconnects: 0 });
    handlers.stats?.({ msgsIn: 4, msgsOut: 1, deltasIn: 0, rttMs: 12, clockOffsetMs: null });
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

  it('shows the summary strip and the server figures from a summary message', async () => {
    const { client, handlers } = makeClient();
    render(<App client={client} wsUrl="ws://host/ws" />);
    expect(screen.getByTestId('summary-LIVE')).toHaveTextContent('LIVE—');
    act(() => {
      (handlers.message as (m: unknown) => void)({
        t: 'summary',
        byStatus: { PENDING_START: 5, LIVE: 450, PAUSED: 2, FILLED: 900, CANCELLED: 100 },
        liveNotionalUsd: 4_210_000_000,
        totalRows: 1_001_234,
        server: { cpu: 8.3, rssMb: 853, elLagMs: 2.5 },
      });
    });
    expect(screen.getByTestId('summary-LIVE')).toHaveTextContent('LIVE450');
    expect(screen.getByTestId('summary-notional')).toHaveTextContent('$4.21bn');
    expect(screen.getByTestId('status-rows')).toHaveTextContent('1,001,234');
    expect(screen.getByTestId('status-cpu')).toHaveTextContent('8.3%');
    expect(screen.getByTestId('status-lag')).toHaveTextContent('2.5 ms');
  });

  it('sends the load preset as a control message from the dev menu and shows it as active', async () => {
    const { client, control, handlers } = makeClient();
    render(<App client={client} wsUrl="ws://host/ws" />);
    act(() => {
      handlers.message?.(welcome);
    });
    await userEvent.click(screen.getByRole('button', { name: 'Dev' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Stress' }));
    expect(control).toHaveBeenCalledWith('stress');
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Stress' })).toBeChecked();
    });
    expect(screen.getByText(/active: stress/)).toBeInTheDocument();
  });

  it('shows the preset from welcome in the dev menu at once and a STRESS pill in the status bar', async () => {
    const { client, handlers } = makeClient();
    render(<App client={client} wsUrl="ws://host/ws" />);
    expect(screen.queryByTestId('status-preset')).toBeNull();
    act(() => {
      handlers.message?.({ ...welcome, preset: 'stress' });
    });
    expect(screen.getByTestId('status-preset')).toHaveTextContent('STRESS');
    await userEvent.click(screen.getByRole('button', { name: 'Dev' }));
    expect(screen.getByRole('radio', { name: 'Stress' })).toBeChecked();
    act(() => {
      handlers.message?.({ ...welcome, preset: 'medium' });
    });
    expect(screen.queryByTestId('status-preset')).toBeNull();
    expect(screen.getByRole('radio', { name: 'Medium' })).toBeChecked();
  });

  it('toggles the codec both ways from the dev menu', async () => {
    const { client, handlers, hello } = makeClient();
    render(<App client={client} wsUrl="ws://host/ws" />);
    act(() => {
      handlers.message?.(welcome);
    });
    await userEvent.click(screen.getByRole('button', { name: 'Dev' }));
    await userEvent.click(screen.getByRole('radio', { name: 'MessagePack' }));
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'MessagePack' })).toBeChecked();
    });
    await userEvent.click(screen.getByRole('radio', { name: 'JSON' }));
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'JSON' })).toBeChecked();
    });
    expect(hello).toHaveBeenLastCalledWith('ALL', 'json');
  });
});
