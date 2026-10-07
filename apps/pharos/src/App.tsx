import { useEffect, useMemo, type ReactElement } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Header } from './components/Header';
import { StatusBar } from './components/StatusBar';
import { SummaryStrip } from './components/SummaryStrip';
import { Toasts } from './components/Toasts';
import { Blotter } from './grid/Blotter';
import { startFpsMeter } from './metrics/fps-meter';
import { createAppController } from './state/app-controller';
import { useAppStore } from './state/app-store';
import type { BlotterClient } from './transport/client';

export type AppProps = {
  client: BlotterClient;
  /** WebSocket endpoint, `/ws` on the page's own origin. */
  wsUrl: string;
};

export function App({ client, wsUrl }: AppProps): ReactElement {
  const controller = useMemo(() => createAppController(client), [client]);
  // Everything except the new-orders count, which only the badge needs, so the grid is not re-rendered 10 times a second.
  const state = useAppStore(
    useShallow((s) => ({
      status: s.status,
      reconnectAttempt: s.reconnectAttempt,
      codec: s.codec,
      traders: s.traders,
      confirmedTrader: s.confirmedTrader,
      requestedTrader: s.requestedTrader,
      welcomed: s.welcomed,
      preset: s.preset,
      presetPending: s.presetPending,
      rowCount: s.rowCount,
      grouped: s.grouped,
      summary: s.summary,
      rttMs: s.rttMs,
      fps: s.fps,
      msgsInPerSec: s.msgsInPerSec,
      msgsOutPerSec: s.msgsOutPerSec,
      deltasPerSec: s.deltasPerSec,
      rowsUpdatedPerSec: s.rowsUpdatedPerSec,
      latencyP50Ms: s.latencyP50Ms,
      latencyP95Ms: s.latencyP95Ms,
      server: s.server,
      toasts: s.toasts,
      dismissToast: s.dismissToast,
    })),
  );

  useEffect(() => controller.start(wsUrl), [controller, wsUrl]);

  useEffect(
    () =>
      startFpsMeter({
        requestFrame: (cb) => requestAnimationFrame(cb),
        cancelFrame: (handle) => {
          cancelAnimationFrame(handle);
        },
        onSample: (fps) => {
          useAppStore.getState().setFps(fps);
        },
      }),
    [],
  );

  return (
    <div className="app">
      <Header
        traders={state.traders}
        traderId={state.confirmedTrader}
        switching={state.requestedTrader !== state.confirmedTrader}
        codec={state.codec}
        ready={state.welcomed}
        preset={state.preset}
        presetPending={state.presetPending}
        onTraderChange={(id) => {
          void controller.changeTrader(id);
        }}
        onCodecChange={(codec) => {
          void controller.changeCodec(codec);
        }}
        onPresetChange={(preset) => {
          void controller.changePreset(preset);
        }}
      />
      <SummaryStrip summary={state.summary} />
      <main className="app-main">
        <Blotter client={client} controller={controller} />
      </main>
      <StatusBar
        status={state.status}
        reconnectAttempt={state.reconnectAttempt}
        codec={state.codec}
        rowCount={state.rowCount}
        grouped={state.grouped}
        totalRows={state.summary?.totalRows ?? null}
        rttMs={state.rttMs}
        fps={state.fps}
        msgsInPerSec={state.msgsInPerSec}
        msgsOutPerSec={state.msgsOutPerSec}
        deltasPerSec={state.deltasPerSec}
        rowsUpdatedPerSec={state.rowsUpdatedPerSec}
        latencyP50Ms={state.latencyP50Ms}
        latencyP95Ms={state.latencyP95Ms}
        server={state.server}
      />
      <Toasts toasts={state.toasts} onDismiss={state.dismissToast} />
    </div>
  );
}
