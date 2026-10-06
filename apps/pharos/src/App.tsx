import { useEffect, useMemo, type ReactElement } from 'react';
import { Header } from './components/Header';
import { StatusBar } from './components/StatusBar';
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
  const state = useAppStore();

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
        onTraderChange={(id) => {
          void controller.changeTrader(id);
        }}
        onCodecChange={(codec) => {
          void controller.changeCodec(codec);
        }}
      />
      <main className="app-main">
        <Blotter client={client} controller={controller} />
      </main>
      <StatusBar
        status={state.status}
        reconnectAttempt={state.reconnectAttempt}
        codec={state.codec}
        rowCount={state.rowCount}
        grouped={state.grouped}
        rttMs={state.rttMs}
        fps={state.fps}
        msgsInPerSec={state.msgsInPerSec}
        msgsOutPerSec={state.msgsOutPerSec}
        server={state.server}
      />
      <Toasts toasts={state.toasts} onDismiss={state.dismissToast} />
    </div>
  );
}
