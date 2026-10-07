import { afterEach, describe, expect, it, vi } from 'vitest';
import { Timeline, realClock, runTimeline, type Clock } from './schedule.js';

afterEach(() => vi.useRealTimers());

/** A clock that only moves when something sleeps. */
function manualClock(start = 0): Clock & { t: number } {
  const c = {
    t: start,
    now: (): number => c.t,
    sleep: (ms: number): Promise<void> => {
      c.t += Math.max(0, ms);
      return Promise.resolve();
    },
  };
  return c;
}

describe('Timeline', () => {
  it('spaces slots by the interval from the start, independent of anything else', () => {
    const t = new Timeline({ startMs: 1000, intervalMs: 500, jitter: 0, rng: () => 0.5 });
    expect([t.next(), t.next(), t.next()]).toEqual([1000, 1500, 2000]);
  });

  it('keeps jitter within a fraction of the interval, never before the start, and never reorders slots', () => {
    let i = 0;
    const rng = (): number => [0, 1, 0, 1, 0.5][i++ % 5] as number;
    const t = new Timeline({ startMs: 0, intervalMs: 100, jitter: 0.49, rng });
    const times = Array.from({ length: 200 }, () => t.next());
    expect(Math.min(...times)).toBeGreaterThanOrEqual(0);
    for (let k = 1; k < times.length; k++) expect(times[k]).toBeGreaterThanOrEqual(times[k - 1] as number);
    times.forEach((v, k) => expect(Math.abs(v - k * 100)).toBeLessThanOrEqual(49 + 1e-9));
  });

  it('is deterministic for a given rng', () => {
    const make = (): Timeline => {
      let s = 1;
      return new Timeline({ startMs: 0, intervalMs: 100, jitter: 0.3, rng: () => (s = (s * 16807) % 2147483647) / 2147483647 });
    };
    const a = make();
    const b = make();
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()]);
  });

  it('rejects an impossible interval or jitter', () => {
    expect(() => new Timeline({ startMs: 0, intervalMs: 0, jitter: 0, rng: Math.random })).toThrow();
    expect(() => new Timeline({ startMs: 0, intervalMs: 10, jitter: 0.5, rng: Math.random })).toThrow();
  });
});

describe('runTimeline', () => {
  it('fires each slot at its intended time and stops before endMs', async () => {
    const clock = manualClock();
    const fired: [number, number][] = [];
    const n = await runTimeline({
      clock,
      timeline: new Timeline({ startMs: 0, intervalMs: 100, jitter: 0, rng: () => 0.5 }),
      endMs: 1000,
      fire: (i, a) => fired.push([i, a]),
    });
    expect(n).toBe(10);
    expect(fired.every(([i, a]) => i === a)).toBe(true);
    expect(fired.at(-1)?.[0]).toBe(900);
  });

  it('is open loop: a slow response does not delay later slots, and a late send is still due at its intended time', async () => {
    // The consumer blocks the clock for 350 ms at the first slot (a slow server, or a stalled generator).
    const clock = manualClock();
    const fired: [number, number][] = [];
    await runTimeline({
      clock,
      timeline: new Timeline({ startMs: 0, intervalMs: 100, jitter: 0, rng: () => 0.5 }),
      endMs: 600,
      fire: (i, a) => {
        fired.push([i, a]);
        if (i === 0) clock.t += 350;
      },
    });
    expect(fired.map(([i]) => i)).toEqual([0, 100, 200, 300, 400, 500]);
    // Slots 100..300 were overdue and went out at once, at 350, with their intended times intact.
    expect(fired.slice(1, 4).map(([, a]) => a)).toEqual([350, 350, 350]);
    expect(fired[5]?.[1]).toBe(500);
  });

  it('measuring from the intended time counts the stall; measuring from the actual send would hide it', async () => {
    const clock = manualClock();
    const fromIntended: number[] = [];
    const fromActual: number[] = [];
    await runTimeline({
      clock,
      timeline: new Timeline({ startMs: 0, intervalMs: 100, jitter: 0, rng: () => 0.5 }),
      endMs: 500,
      fire: (intended, actual) => {
        if (intended === 0) clock.t += 300;
        const responseAt = clock.now() + 10;
        fromIntended.push(responseAt - intended);
        fromActual.push(responseAt - actual);
      },
    });
    expect(Math.max(...fromIntended)).toBeGreaterThan(300);
    expect(Math.max(...fromActual)).toBeLessThanOrEqual(310);
  });

  it('stops when asked', async () => {
    const clock = manualClock();
    let stop = false;
    const n = await runTimeline({
      clock,
      timeline: new Timeline({ startMs: 0, intervalMs: 10, jitter: 0, rng: () => 0.5 }),
      endMs: 10_000,
      stopped: () => stop,
      fire: (i) => {
        if (i >= 30) stop = true;
      },
    });
    expect(n).toBe(4);
  });

  it('works on the real clock with fake timers', async () => {
    vi.useFakeTimers({ now: 0 });
    const fired: number[] = [];
    const run = runTimeline({
      clock: realClock,
      timeline: new Timeline({ startMs: 0, intervalMs: 250, jitter: 0, rng: () => 0.5 }),
      endMs: 1000,
      fire: (i) => fired.push(i),
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await run).toBe(4);
    expect(fired).toEqual([0, 250, 500, 750]);
  });
});
