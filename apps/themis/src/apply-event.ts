import type { Order, OrderEvent } from '@apeiron/logos';
import type { StoredOrder } from '@apeiron/mnemosyne';

export type EventOutcome =
  /** The order changed: `record` is its next version and `srcTs` the producer's timestamp. */
  | { kind: 'changed'; record: StoredOrder; srcTs: number }
  /** The event carried nothing new (a replay, or a repeated NEW). */
  | { kind: 'unchanged' }
  /** An UPDATE for an order nobody holds. */
  | { kind: 'unknown' }
  /** A REJECT: it answers a command, and changes no order. */
  | { kind: 'ignored' };

const differs = (current: Order, patch: Partial<Order>): boolean =>
  (Object.keys(patch) as (keyof Order)[]).some((key) => patch[key] !== current[key]);

/**
 * Applies one `orders.events` message to the stored order (`current`, undefined when the order is not held) and
 * returns its next version. Every field in an event is absolute, so a replay changes nothing the second time. A
 * NEW for an order that already exists is an upsert. `execSeq` is carried over unchanged: events carry none.
 */
export function applyOrderEvent(current: StoredOrder | undefined, event: OrderEvent): EventOutcome {
  if (event.type === 'REJECT') return { kind: 'ignored' };
  if (event.type === 'NEW') {
    if (current === undefined) {
      return { kind: 'changed', record: { order: event.order, v: 1, execSeq: event.order.numFills }, srcTs: event.ts };
    }
    if (!differs(current.order, event.order)) return { kind: 'unchanged' };
    return { kind: 'changed', record: { order: event.order, v: current.v + 1, execSeq: current.execSeq }, srcTs: event.ts };
  }
  if (current === undefined) return { kind: 'unknown' };
  if (!differs(current.order, event.order)) return { kind: 'unchanged' };
  return {
    kind: 'changed',
    record: { order: { ...current.order, ...event.order }, v: current.v + 1, execSeq: current.execSeq },
    srcTs: event.ts,
  };
}
