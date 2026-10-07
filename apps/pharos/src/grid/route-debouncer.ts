export type Timers = {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export type RouteDebouncer = {
  /** Asks for the route to be refreshed. Runs at once if the route has been quiet, else at the end of its interval. */
  request(route: readonly string[]): void;
  /** Cancels everything pending and forgets when routes last ran. */
  reset(): void;
};

type RouteState = { route: string[]; lastRun: number; timer: unknown };

const routeKey = (route: readonly string[]): string => route.join('\u0000');

/**
 * At most one run per `intervalMs` per route. The first request after a quiet period runs immediately;
 * requests that arrive inside the interval collapse into one run when the interval ends.
 */
export function createRouteDebouncer(run: (route: string[]) => void, intervalMs: number, timers: Timers): RouteDebouncer {
  const states = new Map<string, RouteState>();

  return {
    request(route): void {
      const key = routeKey(route);
      const now = timers.now();
      let state = states.get(key);
      if (state === undefined) {
        state = { route: [...route], lastRun: Number.NEGATIVE_INFINITY, timer: null };
        states.set(key, state);
      }
      if (state.timer !== null) return;
      const wait = state.lastRun + intervalMs - now;
      if (wait <= 0) {
        state.lastRun = now;
        run(state.route);
        return;
      }
      const target = state;
      target.timer = timers.setTimeout(() => {
        target.timer = null;
        target.lastRun = timers.now();
        run(target.route);
      }, wait);
    },

    reset(): void {
      for (const state of states.values()) {
        if (state.timer !== null) timers.clearTimeout(state.timer);
      }
      states.clear();
    },
  };
}
