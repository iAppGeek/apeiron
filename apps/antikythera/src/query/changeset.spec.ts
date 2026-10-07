import { describe, expect, it } from 'vitest';
import { ChangeSet, maskOf } from './changeset.js';

const intersects = (a: { lo: number; hi: number }, b: { lo: number; hi: number }): boolean => (a.lo & b.lo) !== 0 || (a.hi & b.hi) !== 0;

describe('maskOf', () => {
  it('intersects exactly when fields overlap, across both 32-bit halves', () => {
    expect(intersects(maskOf(['orderQty']), maskOf(['orderQty', 'side']))).toBe(true);
    expect(intersects(maskOf(['orderQty']), maskOf(['side']))).toBe(false);
    expect(intersects(maskOf(['durationMins']), maskOf(['durationMins']))).toBe(true);
    expect(intersects(maskOf(['durationMins']), maskOf(['orderId']))).toBe(false);
    expect(maskOf([])).toEqual({ lo: 0, hi: 0 });
  });
});

describe('ChangeSet', () => {
  it('records updates with their previous values and masks', () => {
    const cs = new ChangeSet();
    cs.noteUpdate(3, ['filledQty', 'slippageBps'], { filledQty: 1, slippageBps: null });
    const e = cs.entries.get(3);
    expect(e?.isNew).toBe(false);
    expect([...(e?.fields ?? [])]).toEqual(['filledQty', 'slippageBps']);
    expect(e?.prev).toEqual({ filledQty: 1, slippageBps: null });
    expect(intersects(e ?? { lo: 0, hi: 0 }, maskOf(['slippageBps']))).toBe(true);
    expect(cs.has(3)).toBe(true);
    expect(cs.size).toBe(1);
  });

  it('keeps the first previous value when a row changes twice and unions the fields', () => {
    const cs = new ChangeSet();
    cs.noteUpdate(1, ['filledQty'], { filledQty: 10 });
    cs.noteUpdate(1, ['filledQty', 'venue'], { filledQty: 20, venue: 'EBS' });
    expect(cs.entries.get(1)?.prev).toEqual({ filledQty: 10, venue: 'EBS' });
    expect(cs.entries.get(1)?.fields.size).toBe(2);
  });

  it('ignores empty updates and treats a new row as new even after updates', () => {
    const cs = new ChangeSet();
    cs.noteUpdate(1, [], {});
    expect(cs.size).toBe(0);
    cs.noteNew(2);
    cs.noteUpdate(2, ['filledQty'], { filledQty: 0 });
    expect(cs.entries.get(2)?.isNew).toBe(true);
    cs.noteUpdate(5, ['filledQty'], { filledQty: 0 });
    cs.noteNew(5);
    expect(cs.entries.get(5)?.isNew).toBe(true);
  });

  it('exposes previous values for changed rows only', () => {
    const cs = new ChangeSet();
    cs.noteUpdate(1, ['venue'], { venue: 'EBS' });
    cs.noteNew(2);
    expect(cs.prevOf(1)).toEqual({ venue: 'EBS' });
    expect(cs.prevOf(2)).toBeUndefined();
    expect(cs.prevOf(3)).toBeUndefined();
  });
});
