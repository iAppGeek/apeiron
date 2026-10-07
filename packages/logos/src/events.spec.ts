import { describe, expect, it } from 'vitest';
import {
  orderSchema,
  parseLoadControl,
  parseLoadState,
  SUBJECTS,
  parseOrderCommand,
  parseOrderEvent,
  parsePriceTick,
  priceSubject,
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

  it('accepts a NEW event carrying all 50 fields (including nulls)', () => {
    expect(Object.keys(order)).toHaveLength(50);
    const result = parseOrderEvent({ type: 'NEW', order: { ...order, limitPrice: null }, ts: 5 });
    expect(result.ok).toBe(true);
    expect(orderSchema.safeParse(order).success).toBe(true);
  });

  it('rejects a NEW event with a missing field', () => {
    const partial: Record<string, unknown> = { ...order };
    delete partial.venue;
    expect(parseOrderEvent({ type: 'NEW', order: partial, ts: 5 }).ok).toBe(false);
  });

  it('accepts partial UPDATE events that carry an orderId and strips unknown keys', () => {
    const result = parseOrderEvent({
      type: 'UPDATE',
      order: { orderId: 'ALG00000001', filledQty: 10, avgFillPrice: null, bogus: 1 },
      ts: 5,
      commandId: 'c:1',
    });
    expect(result).toEqual({
      ok: true,
      value: { type: 'UPDATE', order: { orderId: 'ALG00000001', filledQty: 10, avgFillPrice: null }, ts: 5, commandId: 'c:1' },
    });
  });

  it('rejects UPDATE events without an orderId or with wrong types', () => {
    expect(parseOrderEvent({ type: 'UPDATE', order: { filledQty: 1 }, ts: 1 }).ok).toBe(false);
    expect(parseOrderEvent({ type: 'UPDATE', order: { orderId: 'a', status: 'NOPE' }, ts: 1 }).ok).toBe(false);
    expect(parseOrderEvent({ type: 'UPDATE', order: { orderId: 'a', filledQty: '1' }, ts: 1 }).ok).toBe(false);
  });

  it('parses REJECT events', () => {
    const msg = { type: 'REJECT', commandId: 'c:1', orderId: 'ALG1', code: 'INVALID_TRANSITION', message: 'no', ts: 1 };
    expect(parseOrderEvent(msg)).toEqual({ ok: true, value: msg });
    expect(parseOrderEvent({ ...msg, code: 'OTHER' }).ok).toBe(false);
  });

  it('rejects unknown event types', () => {
    expect(parseOrderEvent({ type: 'DELETE', orderId: 'a', ts: 1 }).ok).toBe(false);
  });

  it('parses control and command messages', () => {
    expect(parseLoadControl({ preset: 'stress' })).toEqual({ ok: true, value: { preset: 'stress' } });
    expect(parseLoadControl({ preset: 'huge' }).ok).toBe(false);
    const cmd = { orderId: 'ALG1', action: 'CANCEL', requestedBy: 'c', ts: 1, commandId: 'c:1' };
    expect(parseOrderCommand(cmd)).toEqual({ ok: true, value: cmd });
    expect(parseOrderCommand({ ...cmd, action: 'KILL' }).ok).toBe(false);
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
