import type { ServerMsg } from '@apeiron/logos';

export type DeltaMsg = Extract<ServerMsg, { t: 'delta' }>;

const routeKey = (route: readonly string[]): string => route.join('\u0000');

/**
 * Folds delta `b` (which arrived later) into delta `a`, so that applying the result equals applying `a` then `b`
 * under the client's rule of adds before updates:
 * - `adds` for the same route at index 0 merge with the newer rows on top, as two inserts at the top would leave them;
 * - `updates` merge per route and order id, the later value of each field winning;
 * - `groupUpdates` are whole rows applied in order, so the later rows land last and win;
 * - `dirtyRoutes` are the union, `rowCounts` keep the latest per route, `newAbove` sums, `seq` is the latest;
 * - `serverTs` is the earliest, so the latency measured for a merged delta is the worst case among its parts.
 */
export function mergeDeltas(a: DeltaMsg, b: DeltaMsg): DeltaMsg {
  const adds: DeltaMsg['adds'] = a.adds.map((x) => ({ route: x.route, addIndex: x.addIndex, rows: [...x.rows] }));
  for (const add of b.adds) {
    const key = routeKey(add.route);
    const same = add.addIndex === 0 ? adds.find((x) => x.addIndex === 0 && routeKey(x.route) === key) : undefined;
    if (same !== undefined) same.rows = [...add.rows, ...same.rows];
    else adds.push({ route: add.route, addIndex: add.addIndex, rows: [...add.rows] });
  }

  const updateRoutes = new Map<string, { route: string[]; rows: Map<string, Record<string, unknown>> }>();
  for (const batch of [a.updates, b.updates]) {
    for (const { route, rows } of batch) {
      const key = routeKey(route);
      let entry = updateRoutes.get(key);
      if (entry === undefined) {
        entry = { route, rows: new Map() };
        updateRoutes.set(key, entry);
      }
      for (const row of rows) {
        entry.rows.set(row.orderId, { ...entry.rows.get(row.orderId), ...row });
      }
    }
  }
  const updates = [...updateRoutes.values()].map(({ route, rows }) => ({
    route,
    rows: [...rows.values()] as DeltaMsg['updates'][number]['rows'],
  }));

  const groupRoutes = new Map<string, { route: string[]; rows: DeltaMsg['groupUpdates'][number]['rows'] }>();
  for (const batch of [a.groupUpdates, b.groupUpdates]) {
    for (const { route, rows } of batch) {
      const key = routeKey(route);
      const entry = groupRoutes.get(key);
      if (entry === undefined) groupRoutes.set(key, { route, rows: [...rows] });
      else entry.rows.push(...rows);
    }
  }

  const dirty = new Map<string, string[]>();
  for (const route of [...a.dirtyRoutes, ...b.dirtyRoutes]) dirty.set(routeKey(route), route);

  const counts = new Map<string, DeltaMsg['rowCounts'][number]>();
  for (const count of [...a.rowCounts, ...b.rowCounts]) counts.set(routeKey(count.route), count);

  return {
    t: 'delta',
    seq: b.seq,
    serverTs: Math.min(a.serverTs, b.serverTs),
    updates,
    groupUpdates: [...groupRoutes.values()],
    adds,
    dirtyRoutes: [...dirty.values()],
    rowCounts: [...counts.values()],
    newAbove: a.newAbove + b.newAbove,
  };
}

export type DeltaBatcherDeps = {
  now: () => number;
  /** Schedules `fn` for the next animation frame (the worker falls back to a 16ms timeout). */
  nextFrame: (fn: () => void) => unknown;
  cancelFrame: (handle: unknown) => void;
  emit: (delta: DeltaMsg, merged: number) => void;
  /** Coalescing starts when more than this many deltas arrive within one second. */
  thresholdPerSec?: number;
};

export type DeltaBatcher = {
  push(delta: DeltaMsg): void;
  /** Emits anything held back, in order. Called before the connection state changes. */
  flush(): void;
  dispose(): void;
};

export const DEFAULT_COALESCE_THRESHOLD = 20;

/**
 * Passes deltas straight through at normal rates. If more than `thresholdPerSec` arrive inside a second, deltas
 * are merged and released once per animation frame until the rate drops back under the threshold.
 */
export function createDeltaBatcher(deps: DeltaBatcherDeps): DeltaBatcher {
  const threshold = deps.thresholdPerSec ?? DEFAULT_COALESCE_THRESHOLD;
  let arrivals: number[] = [];
  let held: DeltaMsg | null = null;
  let heldCount = 0;
  let frame: unknown = null;

  const release = (): void => {
    frame = null;
    if (held === null) return;
    const out = held;
    const count = heldCount;
    held = null;
    heldCount = 0;
    deps.emit(out, count);
  };

  return {
    push(delta): void {
      const now = deps.now();
      arrivals.push(now);
      const cutoff = now - 1000;
      let drop = 0;
      while (drop < arrivals.length && (arrivals[drop] as number) <= cutoff) drop += 1;
      if (drop > 0) arrivals = arrivals.slice(drop);

      const coalescing = arrivals.length > threshold || held !== null;
      if (!coalescing) {
        deps.emit(delta, 1);
        return;
      }
      held = held === null ? delta : mergeDeltas(held, delta);
      heldCount += 1;
      frame ??= deps.nextFrame(release);
    },

    flush(): void {
      if (frame !== null) deps.cancelFrame(frame);
      release();
    },

    dispose(): void {
      if (frame !== null) deps.cancelFrame(frame);
      frame = null;
      held = null;
      heldCount = 0;
    },
  };
}
