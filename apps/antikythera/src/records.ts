import type { Order, OrderStateRecord } from '@apeiron/logos';

/**
 * Reads a KV value as a record without validating all 50 fields: a million of them are decoded at start, and the
 * only writer is the order service, which already validated them. Rejects what the blotter could not use: no
 * version, or no order id and status.
 */
export function readRecord(value: unknown): OrderStateRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Partial<OrderStateRecord>;
  if (typeof record.v !== 'number' || !Number.isInteger(record.v) || record.v < 1) return null;
  const order = record.order as Partial<Order> | undefined;
  if (typeof order !== 'object' || order === null) return null;
  if (typeof order.orderId !== 'string' || typeof order.status !== 'string' || typeof order.currencyPair !== 'string') return null;
  return record as OrderStateRecord;
}
