import type { CodecName, TraderInfo } from '@apeiron/logos';
import { create } from 'zustand';
import type { ConnectionStatus } from '../transport/messages';

export type ServerStats = { cpu: number; rssMb: number; elLagMs: number };

export type Toast = { id: number; kind: 'error' | 'info'; text: string };

export type AppState = {
  status: ConnectionStatus;
  reconnectAttempt: number;
  /** True once the server has accepted a hello, so the grid may start requesting rows. */
  welcomed: boolean;
  codec: CodecName;
  traderId: string;
  traders: TraderInfo[];
  /** Exact row count at the root level of the current view; null before the first block. */
  rowCount: number | null;
  rttMs: number | null;
  fps: number | null;
  msgsInPerSec: number;
  msgsOutPerSec: number;
  /** Arrives through `summary` messages (phase 5); null until then. */
  server: ServerStats | null;
  /** True while requests wait for the server to finish loading orders. */
  notReady: boolean;
  toasts: Toast[];
};

export type AppActions = {
  setStatus: (status: ConnectionStatus, attempt: number) => void;
  setWelcomed: (traders: TraderInfo[]) => void;
  setCodec: (codec: CodecName) => void;
  setTraderId: (traderId: string) => void;
  setRowCount: (rowCount: number | null) => void;
  setStats: (stats: { msgsIn: number; msgsOut: number; rttMs: number | null }) => void;
  setFps: (fps: number) => void;
  setServer: (server: ServerStats) => void;
  setNotReady: (notReady: boolean) => void;
  pushToast: (kind: Toast['kind'], text: string) => number;
  dismissToast: (id: number) => void;
};

export const INITIAL_APP_STATE: AppState = {
  status: 'connecting',
  reconnectAttempt: 0,
  welcomed: false,
  codec: 'json',
  traderId: 'ALL',
  traders: [],
  rowCount: null,
  rttMs: null,
  fps: null,
  msgsInPerSec: 0,
  msgsOutPerSec: 0,
  server: null,
  notReady: false,
  toasts: [],
};

let toastSeq = 1;
const MAX_TOASTS = 4;

export const useAppStore = create<AppState & AppActions>()((set) => ({
  ...INITIAL_APP_STATE,
  setStatus: (status, attempt): void => {
    set({ status, reconnectAttempt: attempt });
  },
  setWelcomed: (traders): void => {
    set({ welcomed: true, traders });
  },
  setCodec: (codec): void => {
    set({ codec });
  },
  setTraderId: (traderId): void => {
    set({ traderId });
  },
  setRowCount: (rowCount): void => {
    set({ rowCount });
  },
  setStats: ({ msgsIn, msgsOut, rttMs }): void => {
    set({ msgsInPerSec: msgsIn, msgsOutPerSec: msgsOut, rttMs });
  },
  setFps: (fps): void => {
    set({ fps });
  },
  setServer: (server): void => {
    set({ server });
  },
  setNotReady: (notReady): void => {
    set({ notReady });
  },
  pushToast: (kind, text): number => {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }].slice(-MAX_TOASTS) }));
    return id;
  },
  dismissToast: (id): void => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

/** Restores the initial state; tests call this between cases. */
export function resetAppStore(): void {
  useAppStore.setState(INITIAL_APP_STATE);
}
