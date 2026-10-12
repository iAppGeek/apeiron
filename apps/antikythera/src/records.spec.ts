import type { Order } from '@apeiron/logos';
import { describe, expect, it } from 'vitest';
import { readRecord } from './records.js';
import { makeOrders } from './testing/orders.js';

const order = makeOrders([{}])[0] as Order;

describe('readRecord', () => {
  it('accepts a record and returns it as it is', () => {
    const record = { v: 3, execSeq: 1, srcTs: 5, order };
    expect(readRecord(record)).toBe(record);
  });

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['no version', { order }],
    ['a zero version', { v: 0, order }],
    ['a fractional version', { v: 1.5, order }],
    ['no order', { v: 1 }],
    ['an order without an id', { v: 1, order: { ...order, orderId: undefined } }],
    ['an order without a status', { v: 1, order: { ...order, status: 5 } }],
    ['an order without a pair', { v: 1, order: { ...order, currencyPair: undefined } }],
  ])('rejects %s', (_name, value) => {
    expect(readRecord(value)).toBeNull();
  });
});
