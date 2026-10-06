import type { LoadPreset } from '@apeiron/logos';

export type PresetRates = {
  /** Fills (and the occasional expiry cancel) per second. */
  updatesPerSec: number;
  newOrdersPerSec: number;
  /** LIVE count the simulator tops up to at startup and when the preset changes. */
  liveTarget: number;
  /** Below this many LIVE orders, every new order starts LIVE. */
  liveMin: number;
  /** At this many LIVE orders, new orders start PENDING_START instead. */
  liveCap: number;
  /** PENDING_START orders are not created beyond this. */
  pendingCap: number;
};

/** Appendix E rates. */
export const LOAD_PRESETS: Readonly<Record<LoadPreset, PresetRates>> = {
  medium: { updatesPerSec: 100, newOrdersPerSec: 5, liveTarget: 500, liveMin: 400, liveCap: 600, pendingCap: 300 },
  stress: { updatesPerSec: 2_000, newOrdersPerSec: 50, liveTarget: 3_000, liveMin: 2_000, liveCap: 5_000, pendingCap: 2_000 },
};

/** Price ticks per second per pair (all presets). */
export const TICKS_PER_SECOND = 3;
