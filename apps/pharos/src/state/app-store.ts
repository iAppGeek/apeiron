import type { CodecName, LoadPreset, OrderStatus, TraderInfo } from '@apeiron/logos';
import { create } from 'zustand';
import type { ConnectionStatus } from '../transport/messages';

export type ServerStats = { cpu: number; rssMb: number; elLagMs: number };

/** The last `summary` message, scoped to the selected trader. */
export type SummaryStats = { byStatus: Record<OrderStatus, number>; liveNotionalUsd: number; totalRows: number };

/** Live figures the controller publishes about once a second. */
export type LiveStats = {
  /** Rolling p50 and p95 tick-to-screen latency over the last 10 seconds, null until a delta has been applied. */
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  deltasPerSec: number;
  rowsUpdatedPerSec: number;
};

export type Toast = { id: number; kind: 'error' | 'info'; text: string };

export type AppState = {
  status: ConnectionStatus;
  reconnectAttempt: number;
  /** Successful reconnects since the page loaded. */
  reconnects: number;
  /** Why the socket last went away: `code:1006`, `stale:6100ms` (half open), `connect-timeout:6000ms`; null before any drop. */
  lastCloseReason: string | null;
  /** True once the server has accepted a hello, so the grid may start requesting rows. */
  welcomed: boolean;
  codec: CodecName;
  /** The trader the user picked last; reconnects send this one. */
  requestedTrader: string;
  /** The trader the server confirmed in a welcome; the selector shows this one. */
  confirmedTrader: string;
  traders: TraderInfo[];
  /** Exact row count at the root level of the current view; null before the first block. */
  rowCount: number | null;
  /** True when `rowCount` counts root groups rather than rows. */
  grouped: boolean;
  rttMs: number | null;
  fps: number | null;
  msgsInPerSec: number;
  msgsOutPerSec: number;
  /** Arrives through `summary` messages; null until then. */
  server: ServerStats | null;
  summary: SummaryStats | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  deltasPerSec: number;
  rowsUpdatedPerSec: number;
  /** The mock middleware load preset as last set from this page; null until the user picks one. */
  preset: LoadPreset | null;
  presetPending: boolean;
  /** New orders that arrived above a scrolled-down viewport since the user last looked at the top. */
  newOrders: number;
  /** True while requests wait for the server to finish loading orders. */
  notReady: boolean;
  toasts: Toast[];
};

export type AppActions = {
  setStatus: (status: ConnectionStatus, attempt: number, reconnects?: number) => void;
  setCloseReason: (reason: string) => void;
  setWelcomed: (traders: TraderInfo[]) => void;
  setCodec: (codec: CodecName) => void;
  setRequestedTrader: (traderId: string) => void;
  setConfirmedTrader: (traderId: string) => void;
  setRowCount: (rowCount: number | null, grouped?: boolean) => void;
  setStats: (stats: { msgsIn: number; msgsOut: number; rttMs: number | null }) => void;
  setFps: (fps: number) => void;
  setServer: (server: ServerStats) => void;
  setSummary: (summary: SummaryStats) => void;
  setLive: (live: LiveStats) => void;
  setPreset: (preset: LoadPreset | null) => void;
  setPresetPending: (pending: boolean) => void;
  addNewOrders: (count: number) => void;
  clearNewOrders: () => void;
  setNotReady: (notReady: boolean) => void;
  pushToast: (kind: Toast['kind'], text: string) => number;
  dismissToast: (id: number) => void;
};

export const INITIAL_APP_STATE: AppState = {
  status: 'connecting',
  reconnectAttempt: 0,
  reconnects: 0,
  lastCloseReason: null,
  welcomed: false,
  codec: 'json',
  requestedTrader: 'ALL',
  confirmedTrader: 'ALL',
  traders: [],
  rowCount: null,
  grouped: false,
  rttMs: null,
  fps: null,
  msgsInPerSec: 0,
  msgsOutPerSec: 0,
  server: null,
  summary: null,
  latencyP50Ms: null,
  latencyP95Ms: null,
  deltasPerSec: 0,
  rowsUpdatedPerSec: 0,
  preset: null,
  presetPending: false,
  newOrders: 0,
  notReady: false,
  toasts: [],
};

let toastSeq = 1;
const MAX_TOASTS = 4;

export const useAppStore = create<AppState & AppActions>()((set) => ({
  ...INITIAL_APP_STATE,
  setStatus: (status, attempt, reconnects): void => {
    set(reconnects === undefined ? { status, reconnectAttempt: attempt } : { status, reconnectAttempt: attempt, reconnects });
  },
  setCloseReason: (lastCloseReason): void => {
    set({ lastCloseReason });
  },
  setWelcomed: (traders): void => {
    set({ welcomed: true, traders });
  },
  setCodec: (codec): void => {
    set({ codec });
  },
  setRequestedTrader: (requestedTrader): void => {
    set({ requestedTrader });
  },
  setConfirmedTrader: (confirmedTrader): void => {
    set({ confirmedTrader });
  },
  setRowCount: (rowCount, grouped = false): void => {
    set({ rowCount, grouped });
  },
  setStats: ({ msgsIn, msgsOut, rttMs }): void => {
    set({ msgsInPerSec: msgsIn, msgsOutPerSec: msgsOut, rttMs });
  },
  setSummary: (summary): void => {
    set({ summary });
  },
  setLive: (live): void => {
    set(live);
  },
  setPreset: (preset): void => {
    set({ preset });
  },
  setPresetPending: (presetPending): void => {
    set({ presetPending });
  },
  addNewOrders: (count): void => {
    set((s) => ({ newOrders: s.newOrders + count }));
  },
  clearNewOrders: (): void => {
    set((s) => (s.newOrders === 0 ? s : { newOrders: 0 }));
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
