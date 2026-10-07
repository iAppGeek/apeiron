import { z } from 'zod';
import {
  ALGO_TYPES,
  CURRENCY_PAIRS,
  ORDER_STATUSES,
  ORDER_TYPES,
  SIDES,
  TENORS,
  TIME_IN_FORCE,
  URGENCIES,
  VENUES,
  type CurrencyPair,
  type Order,
} from './order.js';
import { COMMAND_ACTIONS, type CommandAction, type LoadPreset, type ParseResult } from './protocol.js';

/** NATS subjects and JetStream names (Appendix C). */
export const SUBJECTS = {
  ordersEvents: 'orders.events',
  ordersCommands: 'orders.commands',
  controlLoad: 'control.load',
  /** Hermes reports the preset it is running, at startup, on every change and every few seconds. */
  controlState: 'control.state',
  pricesWildcard: 'prices.*',
} as const;

export const STREAMS = { orders: 'ORDERS', prices: 'PRICES' } as const;
export const CONSUMERS = { blotterServer: 'blotter-server', hermesCommands: 'hermes-commands' } as const;

export const priceSubject = (pair: CurrencyPair): string => `prices.${pair}`;

export type PriceTick = { pair: CurrencyPair; bid: number; ask: number; ts: number };

export type RejectCode = 'INVALID_TRANSITION' | 'UNKNOWN_ORDER';
export const REJECT_CODES = ['INVALID_TRANSITION', 'UNKNOWN_ORDER'] as const satisfies readonly RejectCode[];

/** The id that ties a client request to the events it causes: `"<clientId>:<reqId>"`. */
export const makeCommandId = (clientId: string, reqId: number): string => `${clientId}:${reqId}`;

/**
 * `orders.events` payloads. Every field value is absolute and post-change, never an increment, so
 * applying an event is idempotent: replaying the stream, or a NEW for an order already stored, is an upsert.
 */
export type OrderEvent =
  | { type: 'NEW'; order: Order; ts: number; commandId?: string }
  | { type: 'UPDATE'; order: Partial<Order> & { orderId: string }; ts: number; commandId?: string }
  | { type: 'REJECT'; commandId: string; orderId: string; code: RejectCode; message: string; ts: number };

export type LoadControl = { preset: LoadPreset };

/** `control.state` payload: the preset hermes is running. */
export type LoadState = { preset: LoadPreset };

export type OrderCommand = {
  orderId: string;
  action: CommandAction;
  requestedBy: string;
  ts: number;
  /** `"<clientId>:<reqId>"` */
  commandId: string;
};

const num = z.number();
const nullableNum = z.number().nullable();

const orderShape = {
  orderId: z.string().min(1),
  parentOrderId: z.string(),
  clientOrderId: z.string(),
  traderId: z.string(),
  traderName: z.string(),
  account: z.string(),
  currencyPair: z.enum(CURRENCY_PAIRS),
  baseCcy: z.string(),
  quoteCcy: z.string(),
  tenor: z.enum(TENORS),
  valueDate: num,
  side: z.enum(SIDES),
  algoType: z.enum(ALGO_TYPES),
  status: z.enum(ORDER_STATUSES),
  orderType: z.enum(ORDER_TYPES),
  timeInForce: z.enum(TIME_IN_FORCE),
  urgency: z.enum(URGENCIES),
  venue: z.enum(VENUES),
  strategyParams: z.string(),
  orderQty: num,
  filledQty: num,
  remainingQty: num,
  pctComplete: num,
  notionalUsd: num,
  filledNotionalUsd: num,
  limitPrice: nullableNum,
  arrivalPrice: num,
  avgFillPrice: nullableNum,
  marketBid: num,
  marketAsk: num,
  marketMid: num,
  lastFillPrice: nullableNum,
  distanceToLimitBps: nullableNum,
  spreadBps: num,
  slippageBps: nullableNum,
  slippageUsd: num,
  unrealisedPnlUsd: num,
  realisedPnlUsd: num,
  vwapBenchmark: nullableNum,
  perfVsVwapBps: nullableNum,
  numFills: num,
  numChildOrders: num,
  participationRate: num,
  lastFillQty: num,
  createdAt: num,
  startTime: num,
  endTime: num,
  lastUpdateTime: num,
  completedAt: nullableNum,
  durationMins: num,
};

export const orderSchema: z.ZodType<Order> = z.object(orderShape);

const partialOrderSchema: z.ZodType<Partial<Order> & { orderId: string }> = z
  .object(orderShape)
  .partial()
  .extend({ orderId: z.string().min(1) });

export const priceTickSchema: z.ZodType<PriceTick> = z.object({
  pair: z.enum(CURRENCY_PAIRS),
  bid: z.number().positive(),
  ask: z.number().positive(),
  ts: num,
});

export const orderEventSchema: z.ZodType<OrderEvent> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('NEW'), order: orderSchema, ts: num, commandId: z.string().optional() }),
  z.object({ type: z.literal('UPDATE'), order: partialOrderSchema, ts: num, commandId: z.string().optional() }),
  z.object({
    type: z.literal('REJECT'),
    commandId: z.string(),
    orderId: z.string(),
    code: z.enum(REJECT_CODES),
    message: z.string(),
    ts: num,
  }),
]);

export const loadControlSchema: z.ZodType<LoadControl> = z.object({ preset: z.enum(['medium', 'stress']) });

export const loadStateSchema: z.ZodType<LoadState> = z.object({ preset: z.enum(['medium', 'stress']) });

export const orderCommandSchema: z.ZodType<OrderCommand> = z.object({
  orderId: z.string().min(1),
  action: z.enum(COMMAND_ACTIONS),
  requestedBy: z.string(),
  ts: num,
  commandId: z.string().min(1),
});

function parseWith<T>(schema: z.ZodType<T>, input: unknown): ParseResult<T> {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
}

export const parsePriceTick = (input: unknown): ParseResult<PriceTick> => parseWith(priceTickSchema, input);
export const parseOrderEvent = (input: unknown): ParseResult<OrderEvent> => parseWith(orderEventSchema, input);
export const parseLoadControl = (input: unknown): ParseResult<LoadControl> => parseWith(loadControlSchema, input);
export const parseLoadState = (input: unknown): ParseResult<LoadState> => parseWith(loadStateSchema, input);
export const parseOrderCommand = (input: unknown): ParseResult<OrderCommand> => parseWith(orderCommandSchema, input);
