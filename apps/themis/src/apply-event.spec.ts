import { sampleOrders, type Order, type OrderEvent } from '@apeiron/logos';
import type { StoredOrder } from '@apeiron/mnemosyne';
import { describe, expect, it } from 'vitest';
import { applyOrderEvent } from './apply-event.js';

const base = { ...(sampleOrders(1)[0] as Order), status: 'LIVE' as const, numFills: 2 };
const stored = (overrides: Partial<StoredOrder> = {}): StoredOrder => ({ order: base, v: 4, execSeq: 2, ...overrides });
const update = (patch: Partial<Order>, ts = 100): OrderEvent => ({ type: 'UPDATE', order: { orderId: base.orderId, ...patch }, ts });

describe('applyOrderEvent', () => {
  it('creates a new order at v = 1 with execSeq = numFills', () => {
    const outcome = applyOrderEvent(undefined, { type: 'NEW', order: base, ts: 50 });
    expect(outcome).toEqual({ kind: 'changed', record: { order: base, v: 1, execSeq: 2 }, srcTs: 50 });
  });

  it('treats a repeated NEW as unchanged, and a NEW with different values as an upsert at v + 1', () => {
    expect(applyOrderEvent(stored(), { type: 'NEW', order: base, ts: 1 })).toEqual({ kind: 'unchanged' });
    const outcome = applyOrderEvent(stored(), { type: 'NEW', order: { ...base, urgency: 'HIGH' }, ts: 7 });
    expect(outcome).toMatchObject({ kind: 'changed', record: { v: 5, execSeq: 2, order: { urgency: 'HIGH' } }, srcTs: 7 });
  });

  it('merges an UPDATE into the stored order and bumps v, keeping execSeq', () => {
    const outcome = applyOrderEvent(stored(), update({ filledQty: 500, lastUpdateTime: 99 }, 99));
    expect(outcome).toMatchObject({ kind: 'changed', srcTs: 99, record: { v: 5, execSeq: 2, order: { ...base, filledQty: 500, lastUpdateTime: 99 } } });
  });

  it('is idempotent: replaying an UPDATE changes nothing the second time', () => {
    const first = applyOrderEvent(stored(), update({ filledQty: 500 }));
    if (first.kind !== 'changed') throw new Error('expected a change');
    expect(applyOrderEvent(first.record, update({ filledQty: 500 }))).toEqual({ kind: 'unchanged' });
  });

  it('does not change an UPDATE that repeats the stored values', () => {
    expect(applyOrderEvent(stored(), update({ status: 'LIVE' }))).toEqual({ kind: 'unchanged' });
  });

  it('reports an UPDATE for an order nobody holds', () => {
    expect(applyOrderEvent(undefined, update({ filledQty: 1 }))).toEqual({ kind: 'unknown' });
  });

  it('ignores a REJECT', () => {
    const reject: OrderEvent = { type: 'REJECT', commandId: 'c:1', orderId: base.orderId, code: 'UNKNOWN_ORDER', message: 'x', ts: 1 };
    expect(applyOrderEvent(stored(), reject)).toEqual({ kind: 'ignored' });
  });

  it('does not mutate the stored order', () => {
    const current = stored();
    const copy = structuredClone(current);
    applyOrderEvent(current, update({ filledQty: 9 }));
    expect(current).toEqual(copy);
  });
});
