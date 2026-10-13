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
import type { LoadPreset, ParseResult } from './protocol.js';

/** NATS subjects and JetStream names (Appendix C). */
export const SUBJECTS = {
  controlLoad: 'control.load',
  /** Hermes reports the preset it is running, at startup, on every change and every few seconds. */
  controlState: 'control.state',
  pricesWildcard: 'prices.*',
  /** PLAN1: request/reply from hermes to themis. */
  ordersSubmit: 'orders.submit',
  /** PLAN1: request/reply from a blotter to themis. */
  ordersCmd: 'orders.cmd',
  /** PLAN1: request/reply from hermes to themis; the reply is chunked. */
  ordersQueryOpen: 'orders.query.open',
  /** PLAN1: request/reply from helios to themis (startup fallback only). */
  refMids: 'ref.mids',
  execReports: 'exec.reports',
  execCommands: 'exec.commands',
} as const;

export const STREAMS = { prices: 'PRICES', exec: 'EXEC', venue: 'VENUE' } as const;
export const CONSUMERS = {
  themisExec: 'themis-exec',
  hermesVenue: 'hermes-venue',
} as const;
/** PLAN1: JetStream KV buckets. `ORDER_STATE` is keyed by `orderId`; `ORDER_STATE_META` holds the `projection` marker. */
export const BUCKETS = { orderState: 'ORDER_STATE', orderStateMeta: 'ORDER_STATE_META' } as const;
export const PROJECTION_KEY = 'projection';
/** KV keys must match this; themis rejects any other `orderId`. */
export const KV_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

export const priceSubject = (pair: CurrencyPair): string => `prices.${pair}`;

export type PriceTick = { pair: CurrencyPair; bid: number; ask: number; ts: number };

/** The id that ties a client request to the events it causes: `"<clientId>:<reqId>"`. */
export const makeCommandId = (clientId: string, reqId: number): string => `${clientId}:${reqId}`;

export type LoadControl = { preset: LoadPreset };

/** `control.state` payload: the preset hermes is running. */
export type LoadState = { preset: LoadPreset };

const num = z.number();
const nullableNum = z.number().nullable();

export const orderShape = {
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

export const priceTickSchema: z.ZodType<PriceTick> = z.object({
  pair: z.enum(CURRENCY_PAIRS),
  bid: z.number().positive(),
  ask: z.number().positive(),
  ts: num,
});

export const loadControlSchema: z.ZodType<LoadControl> = z.object({ preset: z.enum(['medium', 'stress']) });

export const loadStateSchema: z.ZodType<LoadState> = z.object({ preset: z.enum(['medium', 'stress']) });

function parseWith<T>(schema: z.ZodType<T>, input: unknown): ParseResult<T> {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
}

export const parsePriceTick = (input: unknown): ParseResult<PriceTick> => parseWith(priceTickSchema, input);
export const parseLoadControl = (input: unknown): ParseResult<LoadControl> => parseWith(loadControlSchema, input);
export const parseLoadState = (input: unknown): ParseResult<LoadState> => parseWith(loadStateSchema, input);
