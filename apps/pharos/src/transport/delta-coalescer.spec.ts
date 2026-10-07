import { describe, expect, it, vi } from 'vitest';
import { createDeltaBatcher, mergeDeltas, type DeltaMsg } from './delta-coalescer';

const delta = (seq: number, patch: Partial<DeltaMsg> = {}): DeltaMsg => ({
  t: 'delta',
  seq,
  serverTs: 1000 + seq,
  updates: [],
  groupUpdates: [],
  adds: [],
  dirtyRoutes: [],
  rowCounts: [],
  newAbove: 0,
  ...patch,
});

const order = (orderId: string, extra: Record<string, unknown> = {}): DeltaMsg['adds'][number]['rows'][number] =>
  ({ orderId, ...extra }) as DeltaMsg['adds'][number]['rows'][number];

describe('mergeDeltas', () => {
  it('latest value wins per row and field, other fields survive', () => {
    const a = delta(1, { updates: [{ route: [], rows: [{ orderId: 'A', marketMid: 1, filledQty: 10 }, { orderId: 'B', marketMid: 5 }] }] });
    const b = delta(2, { updates: [{ route: [], rows: [{ orderId: 'A', marketMid: 2, spreadBps: 0.5 }] }] });
    const m = mergeDeltas(a, b);
    expect(m.updates).toEqual([
      {
        route: [],
        rows: [
          { orderId: 'A', marketMid: 2, filledQty: 10, spreadBps: 0.5 },
          { orderId: 'B', marketMid: 5 },
        ],
      },
    ]);
  });

  it('keeps routes apart', () => {
    const a = delta(1, { updates: [{ route: ['EURUSD', 'LIVE'], rows: [{ orderId: 'A', marketMid: 1 }] }] });
    const b = delta(2, { updates: [{ route: [], rows: [{ orderId: 'A', marketMid: 2 }] }] });
    expect(mergeDeltas(a, b).updates).toHaveLength(2);
  });

  it('puts later adds on top of earlier ones for the same route, as two inserts at the top would', () => {
    const a = delta(1, { adds: [{ route: [], addIndex: 0, rows: [order('A2'), order('A1')] }] });
    const b = delta(2, { adds: [{ route: [], addIndex: 0, rows: [order('B2'), order('B1')] }] });
    const m = mergeDeltas(a, b);
    expect(m.adds).toHaveLength(1);
    expect(m.adds[0]?.rows.map((r) => r.orderId)).toEqual(['B2', 'B1', 'A2', 'A1']);
  });

  it('keeps adds for different routes or indexes as separate entries, in order', () => {
    const a = delta(1, { adds: [{ route: [], addIndex: 0, rows: [order('A1')] }] });
    const b = delta(2, {
      adds: [
        { route: ['EURUSD'], addIndex: 0, rows: [order('B1')] },
        { route: [], addIndex: 3, rows: [order('B2')] },
      ],
    });
    const m = mergeDeltas(a, b);
    expect(m.adds.map((x) => [x.route.join('|'), x.addIndex, x.rows.map((r) => r.orderId)])).toEqual([
      ['', 0, ['A1']],
      ['EURUSD', 0, ['B1']],
      ['', 3, ['B2']],
    ]);
  });

  it('applies updates to rows added in the same merge, because adds come first', () => {
    const a = delta(1, { adds: [{ route: [], addIndex: 0, rows: [order('A1', { marketMid: 1 })] }] });
    const b = delta(2, { updates: [{ route: [], rows: [{ orderId: 'A1', marketMid: 2 }] }] });
    const m = mergeDeltas(a, b);
    expect(m.adds[0]?.rows[0]).toMatchObject({ orderId: 'A1', marketMid: 1 });
    expect(m.updates[0]?.rows[0]).toMatchObject({ orderId: 'A1', marketMid: 2 });
  });

  it('unions dirty routes, takes the latest row count per route, and sums newAbove', () => {
    const a = delta(1, {
      dirtyRoutes: [['EURUSD'], []],
      rowCounts: [
        { route: [], rowCount: 10 },
        { route: ['EURUSD'], rowCount: 4 },
      ],
      newAbove: 2,
    });
    const b = delta(2, { dirtyRoutes: [['EURUSD'], ['GBPUSD']], rowCounts: [{ route: [], rowCount: 12 }], newAbove: 3 });
    const m = mergeDeltas(a, b);
    expect(m.dirtyRoutes).toEqual([['EURUSD'], [], ['GBPUSD']]);
    expect(m.rowCounts).toEqual([
      { route: [], rowCount: 12 },
      { route: ['EURUSD'], rowCount: 4 },
    ]);
    expect(m.newAbove).toBe(5);
  });

  it('concatenates group rows per route so the later ones are applied last', () => {
    const a = delta(1, { groupUpdates: [{ route: [], rows: [{ pair: 'EURUSD', childCount: 5 }] }] });
    const b = delta(2, { groupUpdates: [{ route: [], rows: [{ pair: 'EURUSD', childCount: 6 }] }, { route: ['EURUSD'], rows: [{ status: 'LIVE', childCount: 1 }] }] });
    const m = mergeDeltas(a, b);
    expect(m.groupUpdates).toEqual([
      {
        route: [],
        rows: [
          { pair: 'EURUSD', childCount: 5 },
          { pair: 'EURUSD', childCount: 6 },
        ],
      },
      { route: ['EURUSD'], rows: [{ status: 'LIVE', childCount: 1 }] },
    ]);
  });

  it('takes the latest seq and the earliest serverTs', () => {
    const m = mergeDeltas(delta(7, { serverTs: 900 }), delta(8, { serverTs: 950 }));
    expect(m.seq).toBe(8);
    expect(m.serverTs).toBe(900);
  });

  it('does not mutate its inputs', () => {
    const a = delta(1, { adds: [{ route: [], addIndex: 0, rows: [order('A')] }] });
    const b = delta(2, { adds: [{ route: [], addIndex: 0, rows: [order('B')] }] });
    const snapshot = structuredClone([a, b]);
    mergeDeltas(a, b);
    expect([a, b]).toEqual(snapshot);
  });
});

describe('createDeltaBatcher', () => {
  const rig = (thresholdPerSec = 3): {
    clock: { t: number };
    frames: (() => void)[];
    emitted: { delta: DeltaMsg; merged: number }[];
    cancel: ReturnType<typeof vi.fn>;
    batcher: ReturnType<typeof createDeltaBatcher>;
  } => {
    const clock = { t: 0 };
    const frames: (() => void)[] = [];
    const emitted: { delta: DeltaMsg; merged: number }[] = [];
    const cancel = vi.fn();
    const batcher = createDeltaBatcher({
      now: () => clock.t,
      nextFrame: (fn) => frames.push(fn),
      cancelFrame: cancel,
      emit: (d, merged) => emitted.push({ delta: d, merged }),
      thresholdPerSec,
    });
    return { clock, frames, emitted, cancel, batcher };
  };

  it('emits straight away at or below the threshold', () => {
    const { clock, emitted, frames, batcher } = rig();
    for (let i = 1; i <= 3; i += 1) {
      clock.t += 100;
      batcher.push(delta(i));
    }
    expect(emitted.map((e) => e.delta.seq)).toEqual([1, 2, 3]);
    expect(frames).toHaveLength(0);
  });

  it('merges above the threshold and releases once per frame', () => {
    const { clock, emitted, frames, batcher } = rig();
    for (let i = 1; i <= 3; i += 1) {
      clock.t += 10;
      batcher.push(delta(i));
    }
    for (let i = 4; i <= 7; i += 1) {
      clock.t += 10;
      batcher.push(delta(i, { newAbove: 1 }));
    }
    expect(emitted).toHaveLength(3);
    expect(frames).toHaveLength(1);
    frames[0]?.();
    expect(emitted).toHaveLength(4);
    expect(emitted[3]).toMatchObject({ merged: 4, delta: { seq: 7, newAbove: 4 } });
  });

  it('goes back to straight through once the rate falls under the threshold', () => {
    const { clock, emitted, frames, batcher } = rig();
    for (let i = 1; i <= 5; i += 1) {
      clock.t += 10;
      batcher.push(delta(i));
    }
    frames[0]?.();
    clock.t += 2000;
    batcher.push(delta(6));
    expect(emitted.at(-1)).toMatchObject({ merged: 1, delta: { seq: 6 } });
  });

  it('keeps order: a delta pushed while one is held joins it instead of overtaking it', () => {
    const { clock, emitted, frames, batcher } = rig(1);
    clock.t += 1;
    batcher.push(delta(1));
    clock.t += 1;
    batcher.push(delta(2));
    clock.t += 1;
    batcher.push(delta(3));
    expect(emitted.map((e) => e.delta.seq)).toEqual([1]);
    frames[0]?.();
    expect(emitted.map((e) => e.delta.seq)).toEqual([1, 3]);
  });

  it('flush emits what is held and cancels the frame', () => {
    const { clock, emitted, cancel, batcher } = rig(1);
    for (let i = 1; i <= 3; i += 1) {
      clock.t += 1;
      batcher.push(delta(i));
    }
    batcher.flush();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(emitted.at(-1)).toMatchObject({ delta: { seq: 3 }, merged: 2 });
    batcher.flush();
    expect(emitted).toHaveLength(2);
  });

  it('dispose drops what is held', () => {
    const { clock, emitted, cancel, batcher } = rig(1);
    for (let i = 1; i <= 3; i += 1) {
      clock.t += 1;
      batcher.push(delta(i));
    }
    batcher.dispose();
    expect(cancel).toHaveBeenCalledTimes(1);
    batcher.flush();
    expect(emitted).toHaveLength(1);
  });
});
