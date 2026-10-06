export type FpsMeterDeps = {
  requestFrame: (callback: (time: number) => void) => number;
  cancelFrame: (handle: number) => void;
  /** Called about once per window with the frames per second measured over it. */
  onSample: (fps: number) => void;
  windowMs?: number;
};

/** Counts animation frames and reports fps once per window (rAF-based, so it reflects main-thread health). */
export function startFpsMeter(deps: FpsMeterDeps): () => void {
  const windowMs = deps.windowMs ?? 1000;
  let frames = 0;
  let windowStart: number | null = null;
  let handle = 0;
  let stopped = false;

  const tick = (time: number): void => {
    if (stopped) return;
    if (windowStart === null) {
      windowStart = time;
    } else {
      frames += 1;
      const elapsed = time - windowStart;
      if (elapsed >= windowMs) {
        deps.onSample(Math.round((frames * 1000) / elapsed));
        frames = 0;
        windowStart = time;
      }
    }
    handle = deps.requestFrame(tick);
  };

  handle = deps.requestFrame(tick);
  return (): void => {
    stopped = true;
    deps.cancelFrame(handle);
  };
}
