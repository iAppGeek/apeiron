import { describe, expect, it, vi } from 'vitest';
import { startFpsMeter } from './fps-meter';

type Rig = { tick: (time: number) => void; onSample: ReturnType<typeof vi.fn>; stop: () => void; cancelFrame: ReturnType<typeof vi.fn> };
const makeRig = (windowMs?: number): Rig => {
  let callback: ((time: number) => void) | null = null;
  const onSample = vi.fn();
  const cancelFrame = vi.fn();
  const stop = startFpsMeter({
    requestFrame: (cb) => {
      callback = cb;
      return 7;
    },
    cancelFrame,
    onSample,
    windowMs,
  });
  return { tick: (time) => callback?.(time), onSample, stop, cancelFrame };
};

describe('startFpsMeter', () => {
  it('reports frames per second once per window', () => {
    const rig = makeRig();
    rig.tick(0);
    for (let t = 1000 / 60; t < 1000; t += 1000 / 60) rig.tick(t);
    expect(rig.onSample).not.toHaveBeenCalled();
    rig.tick(1000);
    expect(rig.onSample).toHaveBeenCalledTimes(1);
    expect(rig.onSample.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(59);
    expect(rig.onSample.mock.calls[0]?.[0]).toBeLessThanOrEqual(61);
  });

  it('reports a low rate when frames are slow', () => {
    const rig = makeRig();
    rig.tick(0);
    rig.tick(500);
    rig.tick(1000);
    expect(rig.onSample).toHaveBeenCalledWith(2);
  });

  it('starts a new window after each sample', () => {
    const rig = makeRig(100);
    rig.tick(0);
    rig.tick(50);
    rig.tick(100);
    rig.tick(150);
    rig.tick(200);
    expect(rig.onSample).toHaveBeenCalledTimes(2);
    expect(rig.onSample).toHaveBeenLastCalledWith(20);
  });

  it('stops and cancels the pending frame', () => {
    const rig = makeRig();
    rig.stop();
    expect(rig.cancelFrame).toHaveBeenCalledWith(7);
    rig.tick(0);
    rig.tick(2000);
    expect(rig.onSample).not.toHaveBeenCalled();
  });
});
