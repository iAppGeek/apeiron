/**
 * The invariant sampler (check 3). Both functions are serialised into the page by Playwright, so each is
 * self-contained: no imports, no references to anything outside its own body.
 */

export type Violation = {
  orderId: string;
  kind: 'filledQty' | 'numFills' | 'lastUpdateTime' | 'terminal-regression';
  previous: number | string;
  current: number | string;
  /** Milliseconds since the sampler was installed. */
  atMs: number;
};

export type SamplerReport = {
  samples: number;
  ordersSeen: number;
  violationCount: number;
  /** The first violations, capped to keep the report small. */
  violations: Violation[];
  /** Slowest gap between two samples (ms): shows whether the page kept up with the 500 ms cadence. */
  maxGapMs: number;
};

type SamplerWindow = {
  __apeironTest?: { loadedRows(): { data: Record<string, unknown> }[] };
  __apeironSampler?: {
    timer: unknown;
    samples: number;
    startedAt: number;
    lastAt: number;
    maxGap: number;
    violationCount: number;
    violations: Violation[];
    orders: Map<string, { filled: number; fills: number; updated: number; terminal: boolean }>;
  };
};

/** Starts sampling `window.__apeironTest.loadedRows()` every `intervalMs`. Idempotent. */
export function installSamplerInPage(intervalMs: number): void {
  const w = globalThis as unknown as SamplerWindow;
  if (w.__apeironSampler !== undefined) return;
  const state: NonNullable<SamplerWindow['__apeironSampler']> = {
    timer: null,
    samples: 0,
    startedAt: Date.now(),
    lastAt: Date.now(),
    maxGap: 0,
    violationCount: 0,
    violations: [],
    orders: new Map(),
  };
  w.__apeironSampler = state;
  state.timer = setInterval(() => {
    const hooks = w.__apeironTest;
    if (hooks === undefined) return;
    const t = Date.now();
    state.maxGap = Math.max(state.maxGap, t - state.lastAt);
    state.lastAt = t;
    state.samples += 1;
    for (const { data } of hooks.loadedRows()) {
      const orderId = String(data['orderId']);
      const filled = Number(data['filledQty']);
      const fills = Number(data['numFills']);
      const updated = Number(data['lastUpdateTime']);
      const status = String(data['status']);
      const terminal = status === 'FILLED' || status === 'CANCELLED';
      const before = state.orders.get(orderId);
      const flag = (kind: Violation['kind'], previous: number | string, current: number | string): void => {
        state.violationCount += 1;
        if (state.violations.length < 50) state.violations.push({ orderId, kind, previous, current, atMs: t - state.startedAt });
      };
      if (before !== undefined) {
        if (filled < before.filled) flag('filledQty', before.filled, filled);
        if (fills < before.fills) flag('numFills', before.fills, fills);
        if (updated < before.updated) flag('lastUpdateTime', before.updated, updated);
        if (before.terminal && !terminal) flag('terminal-regression', 'FILLED or CANCELLED', status);
      }
      state.orders.set(orderId, {
        filled: before === undefined ? filled : Math.max(before.filled, filled),
        fills: before === undefined ? fills : Math.max(before.fills, fills),
        updated: before === undefined ? updated : Math.max(before.updated, updated),
        terminal: terminal || before?.terminal === true,
      });
    }
  }, intervalMs);
}

/** Stops the sampler and returns what it saw. */
export function readSamplerInPage(): SamplerReport {
  const w = globalThis as unknown as SamplerWindow;
  const state = w.__apeironSampler;
  if (state === undefined) return { samples: 0, ordersSeen: 0, violationCount: 0, violations: [], maxGapMs: 0 };
  clearInterval(state.timer as number);
  delete w.__apeironSampler;
  return {
    samples: state.samples,
    ordersSeen: state.orders.size,
    violationCount: state.violationCount,
    violations: state.violations,
    maxGapMs: state.maxGap,
  };
}
