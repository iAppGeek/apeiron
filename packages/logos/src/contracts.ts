import { z } from 'zod';
import { orderSchema, orderShape } from './events.js';
import type { PriceQuote } from './lifecycle.js';
import type { Order } from './order.js';
import {
  COMMAND_ACTIONS,
  amendChangesSchema,
  type AmendChanges,
  type CommandAction,
  type ParseResult,
} from './protocol.js';

/**
 * PLAN1 message contracts (Appendix 1B): the `ORDER_STATE` record, execution reports from the venue,
 * instructions to it, command requests to the order service, and submissions.
 */

/** KV value in `ORDER_STATE`. `v`: per-order version (1 at creation, +1 per accepted change). `execSeq`: last accepted execution. */
export type OrderStateRecord = { v: number; execSeq: number; srcTs: number; order: Order };

export type ProjectionMarker = { ready: boolean; count: number; epoch: string; builtAt: number };

export type Quote = PriceQuote;

export type ExecReport =
  | { type: 'ACTIVATED'; orderId: string; execSeq: number; ts: number }
  | ({ type: 'FILL'; orderId: string; execSeq: number; qty: number; price: number; ts: number } & Quote)
  | ({ type: 'CANCELLED'; orderId: string; execSeq: number; instrId?: string; reason: 'TRADER' | 'EXPIRED'; ts: number } & Quote)
  | { type: 'PAUSED' | 'RESUMED'; orderId: string; execSeq: number; instrId: string; ts: number }
  | { type: 'VENUE_REJECT'; orderId: string; execSeq: number; instrId: string; message: string; ts: number };

/** `instrId` is the command id. */
export type VenueInstruction = { instrId: string; orderId: string; action: CommandAction; ts: number };

export type OrderCommandRequest = {
  /** `"<clientId>:<reqId>"` */
  commandId: string;
  userId: string;
  orderId: string;
} & ({ kind: 'action'; action: CommandAction } | { kind: 'amend'; changes: AmendChanges });

export const COMMAND_REJECT_CODES = [
  'INVALID_TRANSITION',
  'UNKNOWN_ORDER',
  'INVALID_AMEND',
  'VENUE_REJECT',
  'TIMEOUT',
] as const;
export type CommandRejectCode = (typeof COMMAND_REJECT_CODES)[number];
export type OrderCommandReply = { ok: true; v: number } | { ok: false; code: CommandRejectCode; message: string };

/** Idempotent on `clientOrderId`. */
export type Submission = { clientOrderId: string; order: Omit<Order, 'orderId'> };
export type SubmitReply = { ok: true; orderId: string; v: number } | { ok: false; code: 'INVALID_SUBMISSION'; message: string };

const num = z.number();
const seq = z.number().int().min(0);
const base = { orderId: z.string().min(1), execSeq: seq, ts: num };
const quote = { bid: z.number().positive(), ask: z.number().positive() };

export const orderStateRecordSchema: z.ZodType<OrderStateRecord> = z.object({
  v: z.number().int().min(1),
  execSeq: seq,
  srcTs: num,
  order: orderSchema,
});

export const projectionMarkerSchema: z.ZodType<ProjectionMarker> = z.object({
  ready: z.boolean(),
  count: seq,
  epoch: z.string(),
  builtAt: num,
});

export const execReportSchema: z.ZodType<ExecReport> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ACTIVATED'), ...base }),
  z.object({ type: z.literal('FILL'), ...base, qty: num, price: num, ...quote }),
  z.object({
    type: z.literal('CANCELLED'),
    ...base,
    instrId: z.string().optional(),
    reason: z.enum(['TRADER', 'EXPIRED']),
    ...quote,
  }),
  z.object({ type: z.enum(['PAUSED', 'RESUMED']), ...base, instrId: z.string().min(1) }),
  z.object({ type: z.literal('VENUE_REJECT'), ...base, instrId: z.string().min(1), message: z.string() }),
]);

export const venueInstructionSchema: z.ZodType<VenueInstruction> = z.object({
  instrId: z.string().min(1),
  orderId: z.string().min(1),
  action: z.enum(COMMAND_ACTIONS),
  ts: num,
});

const commandBase = { commandId: z.string().min(1), userId: z.string().min(1), orderId: z.string().min(1) };

export const orderCommandRequestSchema: z.ZodType<OrderCommandRequest> = z.discriminatedUnion('kind', [
  z.object({ ...commandBase, kind: z.literal('action'), action: z.enum(COMMAND_ACTIONS) }),
  z.object({ ...commandBase, kind: z.literal('amend'), changes: amendChangesSchema }),
]);

export const orderCommandReplySchema: z.ZodType<OrderCommandReply> = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), v: z.number().int().min(1) }),
  z.object({ ok: z.literal(false), code: z.enum(COMMAND_REJECT_CODES), message: z.string() }),
]);

const { orderId: _orderId, ...submissionOrderShape } = orderShape;

export const submissionSchema: z.ZodType<Submission> = z.object({
  clientOrderId: z.string().min(1),
  order: z.object(submissionOrderShape),
});

export const submitReplySchema: z.ZodType<SubmitReply> = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), orderId: z.string().min(1), v: z.number().int().min(1) }),
  z.object({ ok: z.literal(false), code: z.literal('INVALID_SUBMISSION'), message: z.string() }),
]);

function parseWith<T>(schema: z.ZodType<T>, input: unknown): ParseResult<T> {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
}

export const parseOrderStateRecord = (input: unknown): ParseResult<OrderStateRecord> => parseWith(orderStateRecordSchema, input);
export const parseProjectionMarker = (input: unknown): ParseResult<ProjectionMarker> => parseWith(projectionMarkerSchema, input);
export const parseExecReport = (input: unknown): ParseResult<ExecReport> => parseWith(execReportSchema, input);
export const parseVenueInstruction = (input: unknown): ParseResult<VenueInstruction> => parseWith(venueInstructionSchema, input);
export const parseOrderCommandRequest = (input: unknown): ParseResult<OrderCommandRequest> => parseWith(orderCommandRequestSchema, input);
export const parseOrderCommandReply = (input: unknown): ParseResult<OrderCommandReply> => parseWith(orderCommandReplySchema, input);
export const parseSubmission = (input: unknown): ParseResult<Submission> => parseWith(submissionSchema, input);
export const parseSubmitReply = (input: unknown): ParseResult<SubmitReply> => parseWith(submitReplySchema, input);
