import type { IRowNode } from 'ag-grid-community';
import { describe, expect, it } from 'vitest';
import { createTickTracker } from './tick-tracker';

const node = (id: string): IRowNode => ({ id }) as unknown as IRowNode;

const make = (): { tracker: ReturnType<typeof createTickTracker>; clock: { t: number } } => {
  const clock = { t: 0 };
  return { tracker: createTickTracker({ holdMs: 600, now: () => clock.t }), clock };
};

describe('createTickTracker', () => {
  it('records up and down against the previous value', () => {
    const { tracker } = make();
    tracker.note(node('A'), 'marketMid', 1.1, 1.2, 0);
    tracker.note(node('A'), 'marketBid', 1.1, 1.0, 0);
    expect(tracker.direction('A', 'marketMid')).toBe('up');
    expect(tracker.direction('A', 'marketBid')).toBe('down');
    expect(tracker.previous('A', 'marketMid')).toBe(1.1);
    expect(tracker.size).toBe(2);
  });

  it('ignores unchanged, non-numeric and unknown values', () => {
    const { tracker } = make();
    tracker.note(node('A'), 'marketMid', 1.1, 1.1, 0);
    tracker.note(node('A'), 'marketMid', null, 1.1, 0);
    tracker.note(node('A'), 'marketMid', 1.1, Number.NaN, 0);
    tracker.note(node('A'), 'marketMid', '1', 2, 0);
    tracker.note({ id: undefined } as unknown as IRowNode, 'marketMid', 1, 2, 0);
    expect(tracker.size).toBe(0);
    expect(tracker.direction('A', 'marketMid')).toBeNull();
    expect(tracker.direction(undefined, 'marketMid')).toBeNull();
  });

  it('keeps the latest direction for a cell and counts it once', () => {
    const { tracker } = make();
    tracker.note(node('A'), 'marketMid', 1, 2, 0);
    tracker.note(node('A'), 'marketMid', 2, 1.5, 100);
    expect(tracker.direction('A', 'marketMid')).toBe('down');
    expect(tracker.previous('A', 'marketMid')).toBe(2);
    expect(tracker.size).toBe(1);
  });

  it('stops reporting a direction after the hold window and expires the cell', () => {
    const { tracker, clock } = make();
    const a = node('A');
    tracker.note(a, 'marketMid', 1, 2, 0);
    tracker.note(a, 'marketBid', 1, 2, 300);
    clock.t = 599;
    expect(tracker.direction('A', 'marketMid')).toBe('up');
    clock.t = 600;
    expect(tracker.direction('A', 'marketMid')).toBeNull();
    expect(tracker.direction('A', 'marketBid')).toBe('up');
    expect(tracker.expire(600)).toEqual([{ node: a, fields: ['marketMid'] }]);
    expect(tracker.size).toBe(1);
    expect(tracker.expire(900)).toEqual([{ node: a, fields: ['marketBid'] }]);
    expect(tracker.size).toBe(0);
    expect(tracker.expire(10_000)).toEqual([]);
  });

  it('clear forgets everything', () => {
    const { tracker } = make();
    tracker.note(node('A'), 'marketMid', 1, 2, 0);
    tracker.clear();
    expect(tracker.size).toBe(0);
    expect(tracker.direction('A', 'marketMid')).toBeNull();
  });
});
