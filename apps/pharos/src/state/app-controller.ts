import type { CodecName, ServerMsg } from '@apeiron/logos';
import { describeFailure } from '../grid/errors';
import { RequestError, type BlotterClient } from '../transport/client';
import { useAppStore } from './app-store';

export type AppController = {
  /** Connects the transport and sends the first hello. Returns a function that undoes the wiring. */
  start: (url: string) => () => void;
  changeTrader: (traderId: string) => Promise<void>;
  changeCodec: (codec: CodecName) => Promise<void>;
  /** The grid registers how to purge its row cache; called after a trader change. */
  setPurge: (purge: (() => void) | null) => void;
  /** Phase 5 registers the handler that applies `delta` messages. */
  setDeltaHandler: (handler: ((delta: Extract<ServerMsg, { t: 'delta' }>) => void) | null) => void;
};

/** Glue between the transport client and the app store: wiring, trader and codec changes. */
export function createAppController(client: BlotterClient): AppController {
  let purge: (() => void) | null = null;
  /** Trader hellos sent and not yet answered. */
  let inflightTraderHellos = 0;
  let deltaHandler: ((delta: Extract<ServerMsg, { t: 'delta' }>) => void) | null = null;

  const reportFailure = (error: unknown): void => {
    const state = useAppStore.getState();
    if (error instanceof RequestError) state.pushToast('error', describeFailure(error.code, error.message));
    else state.pushToast('error', error instanceof Error ? error.message : String(error));
  };

  /** The server accepted `traderId`: show it, and reload the grid for it. */
  const confirmTrader = (traderId: string): void => {
    const state = useAppStore.getState();
    state.setConfirmedTrader(traderId);
    state.setRowCount(null);
    purge?.();
  };

  const onMessage = (msg: ServerMsg): void => {
    const state = useAppStore.getState();
    switch (msg.t) {
      case 'welcome':
        state.setWelcomed(msg.traders);
        // A welcome with no trader change in flight is the answer to a reconnect hello, which carries the
        // requested trader, so the server has now confirmed it.
        if (inflightTraderHellos === 0 && state.requestedTrader !== state.confirmedTrader) {
          confirmTrader(state.requestedTrader);
        }
        return;
      case 'summary':
        state.setServer(msg.server);
        return;
      case 'delta':
        deltaHandler?.(msg);
        return;
      case 'error':
        state.pushToast('error', describeFailure(msg.code, msg.message));
        return;
      default:
        return;
    }
  };

  return {
    start(url: string): () => void {
      const offStatus = client.on('status', ({ status, attempt }) => {
        useAppStore.getState().setStatus(status, attempt);
      });
      const offStats = client.on('stats', (stats) => {
        useAppStore.getState().setStats(stats);
      });
      const offMessage = client.on('message', onMessage);
      client.connect(url);
      const { requestedTrader, codec } = useAppStore.getState();
      client.hello(requestedTrader, codec).catch((error: unknown) => {
        // A dropped link is already shown in the status bar, and the reconnect re-sends this hello.
        if (!(error instanceof RequestError && error.code === 'DISCONNECTED')) reportFailure(error);
      });
      return (): void => {
        offStatus();
        offStats();
        offMessage();
      };
    },

    async changeTrader(traderId: string): Promise<void> {
      const { codec, setRequestedTrader } = useAppStore.getState();
      setRequestedTrader(traderId);
      inflightTraderHellos += 1;
      try {
        await client.hello(traderId, codec);
      } catch (error) {
        inflightTraderHellos -= 1;
        // A dropped link keeps the request: the reconnect hello carries it and its welcome confirms it.
        if (error instanceof RequestError && error.code === 'DISCONNECTED') return;
        useAppStore.getState().setRequestedTrader(useAppStore.getState().confirmedTrader);
        reportFailure(error);
        return;
      }
      inflightTraderHellos -= 1;
      confirmTrader(traderId);
    },

    async changeCodec(codec: CodecName): Promise<void> {
      const { requestedTrader, setCodec } = useAppStore.getState();
      try {
        await client.hello(requestedTrader, codec);
      } catch (error) {
        reportFailure(error);
        return;
      }
      setCodec(codec);
    },

    setPurge(next: (() => void) | null): void {
      purge = next;
    },

    setDeltaHandler(handler): void {
      deltaHandler = handler;
    },
  };
}
