import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRouteDebouncer, realTimers } from './route-debouncer';

describe('createRouteDebouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the first request at once, then at most once per interval per route', () => {
    const run = vi.fn();
    const d = createRouteDebouncer(run, 1000, realTimers);
    d.request(['EURUSD']);
    expect(run).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(50);
      d.request(['EURUSD']);
    }
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(499);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith(['EURUSD']);
    // Nothing further is pending.
    vi.advanceTimersByTime(5000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('runs immediately again once the route has been quiet for the interval', () => {
    const run = vi.fn();
    const d = createRouteDebouncer(run, 1000, realTimers);
    d.request([]);
    vi.advanceTimersByTime(1000);
    d.request([]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('debounces each route on its own', () => {
    const run = vi.fn();
    const d = createRouteDebouncer(run, 1000, realTimers);
    d.request(['EURUSD', 'LIVE']);
    d.request(['EURUSD']);
    d.request(['GBPUSD', 'LIVE']);
    expect(run.mock.calls.map((c) => c[0])).toEqual([['EURUSD', 'LIVE'], ['EURUSD'], ['GBPUSD', 'LIVE']]);
    d.request(['EURUSD', 'LIVE']);
    expect(run).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1000);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('reset cancels pending runs and forgets the last run times', () => {
    const run = vi.fn();
    const d = createRouteDebouncer(run, 1000, realTimers);
    d.request([]);
    d.request([]);
    d.reset();
    vi.advanceTimersByTime(5000);
    expect(run).toHaveBeenCalledTimes(1);
    d.request([]);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
