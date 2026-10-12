import { describe, expect, it } from 'vitest';
import {
  parseExecReport,
  parseOrderCommandReply,
  parseOrderCommandRequest,
  parseOrderStateRecord,
  parseProjectionMarker,
  parseSubmission,
  parseSubmitReply,
  parseVenueInstruction,
  type ExecReport,
} from './contracts.js';
import { sampleOrders } from './fixtures.js';
import type { Order } from './order.js';

const order = sampleOrders(1)[0] as Order;
const quote = { bid: 1.0799, ask: 1.0801 };

describe('OrderStateRecord and ProjectionMarker', () => {
  it('round-trips a record and a marker', () => {
    const record = { v: 2, execSeq: 1, srcTs: 5, order };
    expect(parseOrderStateRecord(record)).toEqual({ ok: true, value: record });
    const marker = { ready: true, count: 10, epoch: 'abc', builtAt: 1 };
    expect(parseProjectionMarker(marker)).toEqual({ ok: true, value: marker });
  });

  it('rejects a version below 1, a missing order and a negative count', () => {
    expect(parseOrderStateRecord({ v: 0, execSeq: 0, srcTs: 1, order }).ok).toBe(false);
    expect(parseOrderStateRecord({ v: 1, execSeq: 0, srcTs: 1 }).ok).toBe(false);
    expect(parseProjectionMarker({ ready: true, count: -1, epoch: 'e', builtAt: 1 }).ok).toBe(false);
  });
});

describe('ExecReport', () => {
  const reports: ExecReport[] = [
    { type: 'ACTIVATED', orderId: 'A', execSeq: 1, ts: 1 },
    { type: 'FILL', orderId: 'A', execSeq: 2, qty: 10, price: 1.08, ts: 2, ...quote },
    { type: 'CANCELLED', orderId: 'A', execSeq: 3, reason: 'EXPIRED', ts: 3, ...quote },
    { type: 'CANCELLED', orderId: 'A', execSeq: 3, instrId: 'c:1', reason: 'TRADER', ts: 3, ...quote },
    { type: 'PAUSED', orderId: 'A', execSeq: 4, instrId: 'c:2', ts: 4 },
    { type: 'RESUMED', orderId: 'A', execSeq: 5, instrId: 'c:3', ts: 5 },
    { type: 'VENUE_REJECT', orderId: 'A', execSeq: 6, instrId: 'c:4', message: 'done', ts: 6 },
  ];

  it('accepts every report type', () => {
    for (const report of reports) expect(parseExecReport(report)).toEqual({ ok: true, value: report });
  });

  it('rejects malformed reports', () => {
    for (const bad of [
      null,
      { type: 'FILL', orderId: 'A', execSeq: 1, qty: 1, price: 1, ts: 1 },
      { type: 'FILL', orderId: 'A', execSeq: -1, qty: 1, price: 1, ts: 1, ...quote },
      { type: 'CANCELLED', orderId: 'A', execSeq: 1, reason: 'BORED', ts: 1, ...quote },
      { type: 'PAUSED', orderId: 'A', execSeq: 1, ts: 1 },
      { type: 'UNKNOWN', orderId: 'A', execSeq: 1, ts: 1 },
    ]) {
      expect(parseExecReport(bad).ok).toBe(false);
    }
  });
});

describe('commands, instructions and submissions', () => {
  it('parses venue instructions', () => {
    const instr = { instrId: 'c:1', orderId: 'A', action: 'PAUSE', ts: 1 };
    expect(parseVenueInstruction(instr)).toEqual({ ok: true, value: instr });
    expect(parseVenueInstruction({ ...instr, action: 'DELETE' }).ok).toBe(false);
  });

  it('parses action and amend command requests', () => {
    const action = { commandId: 'c:1', userId: 'TRADER1', orderId: 'A', kind: 'action', action: 'CANCEL' };
    const amend = { commandId: 'c:2', userId: 'TRADER1', orderId: 'A', kind: 'amend', changes: { orderQty: 5 } };
    expect(parseOrderCommandRequest(action)).toEqual({ ok: true, value: action });
    expect(parseOrderCommandRequest(amend)).toEqual({ ok: true, value: amend });
    expect(parseOrderCommandRequest({ ...amend, changes: {} }).ok).toBe(false);
    expect(parseOrderCommandRequest({ ...action, kind: 'other' }).ok).toBe(false);
    expect(parseOrderCommandRequest({ ...action, userId: '' }).ok).toBe(false);
  });

  it('parses command replies', () => {
    expect(parseOrderCommandReply({ ok: true, v: 3 }).ok).toBe(true);
    expect(parseOrderCommandReply({ ok: false, code: 'TIMEOUT', message: 'slow' }).ok).toBe(true);
    expect(parseOrderCommandReply({ ok: false, code: 'NOPE', message: 'x' }).ok).toBe(false);
    expect(parseOrderCommandReply({ ok: true }).ok).toBe(false);
  });

  it('parses submissions and replies', () => {
    const { orderId: _id, ...rest } = order;
    expect(parseSubmission({ clientOrderId: 'c', order: rest }).ok).toBe(true);
    expect(parseSubmission({ clientOrderId: 'c', order }).ok).toBe(true);
    expect(parseSubmission({ clientOrderId: '', order: rest }).ok).toBe(false);
    expect(parseSubmitReply({ ok: true, orderId: 'ALG1', v: 1 }).ok).toBe(true);
    expect(parseSubmitReply({ ok: false, code: 'INVALID_SUBMISSION', message: 'x' }).ok).toBe(true);
    expect(parseSubmitReply({ ok: false, code: 'OTHER', message: 'x' }).ok).toBe(false);
  });
});
