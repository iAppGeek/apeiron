import type { CodecName, LoadPreset, ServerMsg } from '@apeiron/logos';
import type { ApplyStats, DeltaMsg } from '../grid/apply-delta';
import { describeFailure } from '../grid/errors';
import { createLatencyWindow, tickToScreenMs } from '../metrics/latency';
import { RequestError, type BlotterClient } from '../transport/client';
import { useAppStore } from './app-store';

/** Applies a delta to the grid and says how many rows it touched (for the rows-updated-per-second figure). */
export type DeltaHandler = (delta: DeltaMsg) => ApplyStats | void;

export type ControllerDeps = {
  /** Wall clock in ms; the same clock the transport worker uses for ping and clock offset. */
  now?: () => number;
};

/** The close code the server uses with SLOW_CONSUMER. */
export const SLOW_CONSUMER_CLOSE_CODE = 1013;
/** Rolling window of the tick-to-screen latency figures. */
export const LATENCY_WINDOW_MS = 10_000;

export type AppController = {
  /** Connects the transport and sends the first hello. Returns a function that undoes the wiring. */
  start: (url: string) => () => void;
  changeTrader: (traderId: string) => Promise<void>;
  changeCodec: (codec: CodecName) => Promise<void>;
  /** Sends the load preset (medium or stress) to the server, which relays it to the mock middleware. */
  changePreset: (preset: LoadPreset) => Promise<void>;
  /**
   * The grid registers how to purge its row cache and forget its live state. Called after a trader or codec change
   * (the server drops what it tracks on every hello) and after a reconnect, which starts with nothing tracked.
   */
  setPurge: (purge: ((keepPosition: boolean) => void) | null) => void;
  /** The grid registers the handler that applies `delta` messages. */
  setDeltaHandler: (handler: DeltaHandler | null) => void;
};

/** Glue between the transport client and the app store: wiring, trader and codec changes. */
export function createAppController(client: BlotterClient, deps: ControllerDeps = {}): AppController {
  const now = deps.now ?? ((): number => Date.now());
  let purge: ((keepPosition: boolean) => void) | null = null;
  /** Trader hellos sent and not yet answered. */
  let inflightTraderHellos = 0;
  let deltaHandler: DeltaHandler | null = null;

  const latency = createLatencyWindow(LATENCY_WINDOW_MS);
  let clockOffsetMs: number | null = null;
  let rowsUpdated = 0;
  let lastPublishAt = now();
  /** The link dropped (or the server cut us off) after we were welcomed: what the grid holds is no longer being kept up to date. */
  let resyncPending = false;
  let slowConsumerToast = false;

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
    resyncPending = false;
    // Another trader is another table: nothing to keep a place in.
    purge?.(false);
  };

  /** The server cut this client off or the link dropped: reload the grid once the connection is back. */
  const needResync = (): void => {
    if (useAppStore.getState().welcomed) resyncPending = true;
  };

  const onSlowConsumer = (): void => {
    needResync();
    if (slowConsumerToast) return;
    slowConsumerToast = true;
    useAppStore.getState().pushToast('error', 'The blotter fell behind the server. Reconnecting and reloading the rows.');
  };

  const publishLive = (deltasPerSec: number): void => {
    const at = now();
    const snapshot = latency.snapshot(at);
    const elapsed = Math.max(1, at - lastPublishAt) / 1000;
    useAppStore.getState().setLive({
      latencyP50Ms: snapshot.p50,
      latencyP95Ms: snapshot.p95,
      deltasPerSec,
      rowsUpdatedPerSec: rowsUpdated / elapsed,
    });
    rowsUpdated = 0;
    lastPublishAt = at;
  };

  const onDelta = (delta: DeltaMsg): void => {
    if (deltaHandler === null) return;
    const stats = deltaHandler(delta);
    const appliedAt = now();
    latency.record(appliedAt, tickToScreenMs(appliedAt, delta.srcTs, clockOffsetMs));
    if (stats === undefined) return;
    rowsUpdated += stats.rowsUpdated;
    if (stats.rootRowCount !== null) {
      const state = useAppStore.getState();
      state.setRowCount(stats.rootRowCount, state.grouped);
    }
  };

  const onMessage = (msg: ServerMsg): void => {
    const state = useAppStore.getState();
    switch (msg.t) {
      case 'welcome':
        slowConsumerToast = false;
        state.setWelcomed(msg.traders);
        if (msg.preset !== null) state.setPreset(msg.preset);
        // A welcome with no trader change in flight is the answer to a reconnect hello, which carries the
        // requested trader, so the server has now confirmed it.
        if (inflightTraderHellos === 0 && state.requestedTrader !== state.confirmedTrader) {
          confirmTrader(state.requestedTrader);
        } else if (resyncPending) {
          // A fresh session tracks nothing, so deltas stop for every row the grid already holds. Reload them.
          resyncPending = false;
          // Same view, same trader: the user keeps their place.
          purge?.(true);
        }
        return;
      case 'summary':
        state.setServer(msg.server);
        // The server reports null until hermes has said which preset it runs; never let that hide a known one.
        if (msg.preset !== null) state.setPreset(msg.preset);
        state.setSummary({ byStatus: msg.byStatus, liveNotionalUsd: msg.liveNotionalUsd, totalRows: msg.totalRows });
        return;
      case 'delta':
        onDelta(msg);
        return;
      case 'error':
        if (msg.code === 'SLOW_CONSUMER') {
          onSlowConsumer();
          return;
        }
        state.pushToast('error', describeFailure(msg.code, msg.message));
        return;
      default:
        return;
    }
  };

  return {
    start(url: string): () => void {
      const offStatus = client.on('status', ({ status, attempt, reconnects }) => {
        useAppStore.getState().setStatus(status, attempt, reconnects);
      });
      const offStats = client.on('stats', (stats) => {
        useAppStore.getState().setStats(stats);
        clockOffsetMs = stats.clockOffsetMs;
        publishLive(stats.deltasIn);
      });
      const offClosed = client.on('closed', ({ code, reason }) => {
        useAppStore.getState().setCloseReason(reason);
        needResync();
        if (code === SLOW_CONSUMER_CLOSE_CODE) onSlowConsumer();
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
        offClosed();
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
      // The server forgets which blocks this client holds on every hello, so reload them to keep them live.
      purge?.(true);
    },

    async changePreset(preset: LoadPreset): Promise<void> {
      const { setPreset, setPresetPending } = useAppStore.getState();
      setPresetPending(true);
      try {
        await client.control(preset);
        setPreset(preset);
      } catch (error) {
        reportFailure(error);
      } finally {
        setPresetPending(false);
      }
    },

    setPurge(next: ((keepPosition: boolean) => void) | null): void {
      purge = next;
    },

    setDeltaHandler(handler): void {
      deltaHandler = handler;
    },
  };
}
