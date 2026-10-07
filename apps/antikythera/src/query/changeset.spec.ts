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

  it('merges a later tick into an earlier one: first old value wins, new rows stay new', () => {
    const first = new ChangeSet();
    first.noteUpdate(1, ['venue'], { venue: 'EBS' });
    first.noteNew(2);
    first.noteUpdate(4, ['filledQty'], { filledQty: 1 });
    const later = new ChangeSet();
    later.noteUpdate(1, ['venue', 'side'], { venue: 'LMAX', side: 'BUY' });
    later.noteUpdate(2, ['filledQty'], { filledQty: 5 });
    later.noteNew(3);
    later.noteUpdate(7, ['orderQty'], { orderQty: 9 });
    first.merge(later);
    expect(first.entries.get(1)?.prev).toEqual({ venue: 'EBS', side: 'BUY' });
    expect([...(first.entries.get(1)?.fields ?? [])].sort()).toEqual(['side', 'venue']);
    expect(first.entries.get(2)?.isNew).toBe(true);
    expect(first.entries.get(3)?.isNew).toBe(true);
    expect(first.entries.get(4)?.prev).toEqual({ filledQty: 1 });
    expect(first.entries.get(7)?.prev).toEqual({ orderQty: 9 });
    expect(first.size).toBe(5);
    expect(later.size).toBe(4);
  });

  it('keeps the earliest source timestamp per row and for the whole set', () => {
    const cs = new ChangeSet();
    expect(cs.srcTs).toBe(Infinity);
    cs.noteUpdate(1, ['venue'], { venue: 'EBS' }, 500);
    cs.noteUpdate(1, ['side'], { side: 'BUY' }, 300);
    cs.noteUpdate(1, ['status'], { status: 'LIVE' }, 900);
    cs.noteNew(2, 700);
    cs.noteUpdate(3, ['venue'], { venue: 'EBS' });
    expect(cs.entries.get(1)?.ts).toBe(300);
    expect(cs.entries.get(2)?.ts).toBe(700);
    expect(cs.entries.get(3)?.ts).toBe(Infinity);
    expect(cs.srcTs).toBe(300);
  });

  it('carries source timestamps through a merge', () => {
    const first = new ChangeSet();
    first.noteUpdate(1, ['venue'], { venue: 'EBS' }, 500);
    const later = new ChangeSet();
    later.noteUpdate(1, ['side'], { side: 'BUY' }, 400);
    later.noteNew(2, 450);
    first.merge(later);
    expect(first.entries.get(1)?.ts).toBe(400);
    expect(first.entries.get(2)?.ts).toBe(450);
    expect(first.srcTs).toBe(400);
  });
});
