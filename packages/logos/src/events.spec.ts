import { describe, expect, it } from 'vitest';
import {
  orderSchema,
  parseLoadControl,
  parseLoadState,
  STREAMS,
  SUBJECTS,
  parsePriceTick,
  priceSubject,
  makeCommandId,
} from './events.js';
import { sampleOrders } from './fixtures.js';
import type { Order } from './order.js';

const order = sampleOrders(1)[0] as Order;

describe('events', () => {
  it('names price subjects after the pair', () => {
    expect(priceSubject('EURUSD')).toBe('prices.EURUSD');
  });

  it('accepts a valid price tick and rejects bad ones', () => {
    expect(parsePriceTick({ pair: 'EURUSD', bid: 1.08, ask: 1.0801, ts: 1 }).ok).toBe(true);
    expect(parsePriceTick({ pair: 'XXXYYY', bid: 1, ask: 1, ts: 1 }).ok).toBe(false);
    expect(parsePriceTick({ pair: 'EURUSD', bid: -1, ask: 1, ts: 1 }).ok).toBe(false);
    expect(parsePriceTick(null).ok).toBe(false);
  });

  it('has a full order schema: 50 fields, nulls allowed', () => {
    expect(Object.keys(order)).toHaveLength(50);
    expect(orderSchema.safeParse({ ...order, limitPrice: null }).success).toBe(true);
    const partial: Record<string, unknown> = { ...order };
    delete partial.venue;
    expect(orderSchema.safeParse(partial).success).toBe(false);
  });

  it('parses control messages', () => {
    expect(parseLoadControl({ preset: 'stress' })).toEqual({ ok: true, value: { preset: 'stress' } });
    expect(parseLoadControl({ preset: 'huge' }).ok).toBe(false);
  });
});

describe('control.state', () => {
  it('has its own subject and validates the reported preset', () => {
    expect(SUBJECTS.controlState).toBe('control.state');
    expect(parseLoadState({ preset: 'medium' })).toEqual({ ok: true, value: { preset: 'medium' } });
    expect(parseLoadState({ preset: 'stress' }).ok).toBe(true);
    expect(parseLoadState({ preset: 'huge' }).ok).toBe(false);
    expect(parseLoadState({}).ok).toBe(false);
    expect(parseLoadState(null).ok).toBe(false);
  });
});

describe('command correlation', () => {
  it('builds command ids from the client id and request id', () => {
    expect(makeCommandId('client-1', 7)).toBe('client-1:7');
  });

  it('has no subjects or streams for the retired command path: commands go through the order service', () => {
    expect(Object.values(SUBJECTS)).not.toContain('orders.commands');
    expect(Object.values(SUBJECTS)).not.toContain('orders.answers');
    expect(Object.values(SUBJECTS)).not.toContain('orders.events');
    expect(SUBJECTS.ordersCmd).toBe('orders.cmd');
    expect(Object.values(STREAMS)).not.toContain('ORDERS');
  });
});
