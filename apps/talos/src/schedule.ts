/** Time source, injectable so tests can drive it. `now` is epoch ms. */
export type Clock = { now(): number; sleep(ms: number): Promise<void> };

export const realClock: Clock = {
  now: (): number => Date.now(),
  sleep: (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, Math.max(0, ms));
    }),
};

export type TimelineOptions = {
  startMs: number;
  intervalMs: number;
  /** Each send is moved by up to this fraction of the interval either way (0 to 0.49). Slots never reorder. */
  jitter: number;
  rng: () => number;
};

/**
 * The intended send times of an open-loop request stream: slot k is due at `start + k * interval` plus a bounded
 * jitter. The times depend only on the slot number and the rng, never on how long earlier requests took, so a slow
 * server cannot slow the schedule down (coordinated omission).
 */
export class Timeline {
  private slot = 0;

  constructor(private readonly options: TimelineOptions) {
    if (!(options.intervalMs > 0)) throw new Error('intervalMs must be positive');
    if (!(options.jitter >= 0 && options.jitter < 0.5)) throw new Error('jitter must be in [0, 0.5)');
  }

  /** The intended time of the next request. */
  next(): number {
    const { startMs, intervalMs, jitter, rng } = this.options;
    const offset = (rng() * 2 - 1) * jitter * intervalMs;
    // Never earlier than the start, so jitter cannot make the first slots look overdue.
    return Math.max(startMs, startMs + this.slot++ * intervalMs + offset);
  }
}

export type TimelineRun = {
  clock: Clock;
  timeline: Timeline;
  /** Slots due at or after this are not sent. */
  endMs: number;
  /** Called at each slot with its intended time and the time it actually went out. It must not wait for the response. */
  fire: (intendedAt: number, actualAt: number) => void;
  /** Stops the loop at the next slot. */
  stopped?: () => boolean;
};

/**
 * Fires on the timeline until `endMs`. A request is never held back by an earlier one that is still waiting for its
 * response, and a slot already past due goes out at once, so latency is later measured from `intendedAt`, not from
 * when the request happened to be sent. Returns how many slots were fired.
 */
export async function runTimeline(run: TimelineRun): Promise<number> {
  let fired = 0;
  for (;;) {
    if (run.stopped?.() === true) return fired;
    const intendedAt = run.timeline.next();
    if (intendedAt >= run.endMs) return fired;
    // Sleep in slices so a stop request is noticed within a second.
    for (let wait = intendedAt - run.clock.now(); wait > 0; wait = intendedAt - run.clock.now()) {
      await run.clock.sleep(Math.min(wait, 1_000));
      if (run.stopped?.() === true) return fired;
    }
    if (run.stopped?.() === true) return fired;
    run.fire(intendedAt, run.clock.now());
    fired++;
  }
}
