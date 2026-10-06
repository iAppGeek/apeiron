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
  let deltaHandler: ((delta: Extract<ServerMsg, { t: 'delta' }>) => void) | null = null;

  const reportFailure = (error: unknown): void => {
    const state = useAppStore.getState();
    if (error instanceof RequestError) state.pushToast('error', describeFailure(error.code, error.message));
    else state.pushToast('error', error instanceof Error ? error.message : String(error));
  };

  const onMessage = (msg: ServerMsg): void => {
    const state = useAppStore.getState();
    switch (msg.t) {
      case 'welcome':
        state.setWelcomed(msg.traders);
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
      const { traderId, codec } = useAppStore.getState();
      client.hello(traderId, codec).catch((error: unknown) => {
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
      const { codec, setTraderId } = useAppStore.getState();
      try {
        await client.hello(traderId, codec);
      } catch (error) {
        reportFailure(error);
        return;
      }
      setTraderId(traderId);
      useAppStore.getState().setRowCount(null);
      purge?.();
    },

    async changeCodec(codec: CodecName): Promise<void> {
      const { traderId, setCodec } = useAppStore.getState();
      try {
        await client.hello(traderId, codec);
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
