import { z } from 'zod';
import type { Order, OrderStatus, TraderInfo } from './order.js';

export type CodecName = 'json' | 'msgpack';
export type CommandAction = 'CANCEL' | 'PAUSE' | 'RESUME';

/** Subset of AG Grid's `IServerSideGetRowsRequest` that the server supports. */
export type SsrmRequest = {
  startRow: number;
  endRow: number;
  rowGroupCols: { id: string; field?: string; displayName?: string }[];
  valueCols: { id: string; field?: string; aggFunc?: string; displayName?: string }[];
  pivotMode?: boolean;
  groupKeys: string[];
  sortModel: { colId: string; sort: 'asc' | 'desc' }[];
  filterModel?: Record<string, unknown> | null;
};

/** A leaf order or a group row (`childCount` plus aggregates). */
export type Row = Record<string, string | number | boolean | null | undefined>;

export type ClientMsg =
  | { t: 'hello'; traderId: string; codec: CodecName; clientId: string }
  | { t: 'getRows'; reqId: number; req: SsrmRequest }
  | { t: 'setFilterValues'; reqId: number; colId: string }
  | { t: 'command'; reqId: number; orderId: string; action: CommandAction }
  | { t: 'ping'; ts: number };

export type ServerMsg =
  | { t: 'welcome'; serverTime: number; traders: TraderInfo[]; columnsVersion: string }
  | { t: 'rows'; reqId: number; rows: Row[]; rowCount: number; ms: number }
  | { t: 'filterValues'; reqId: number; values: string[] }
  | {
      t: 'delta';
      seq: number;
      serverTs: number;
      updates: { route: string[]; rows: (Partial<Order> & { orderId: string })[] }[];
      groupUpdates: { route: string[]; rows: Row[] }[];
      adds: { route: string[]; addIndex: number; rows: Order[] }[];
      dirtyRoutes: string[][];
      rowCount: number;
      newAbove: number;
    }
  | {
      t: 'summary';
      byStatus: Record<OrderStatus, number>;
      liveNotionalUsd: number;
      server: { cpu: number; rssMb: number; elLagMs: number };
    }
  | { t: 'ack'; reqId: number }
  | { t: 'error'; reqId?: number; code: string; message: string }
  | { t: 'pong'; ts: number; serverTs: number };

export type Message = ClientMsg | ServerMsg;

export const SERVER_MSG_TYPES = [
  'welcome',
  'rows',
  'filterValues',
  'delta',
  'summary',
  'ack',
  'error',
  'pong',
] as const;

const nonNegInt = z.number().int().min(0);

const ssrmRequestSchema: z.ZodType<SsrmRequest> = z.object({
  startRow: nonNegInt,
  endRow: nonNegInt,
  rowGroupCols: z.array(
    z.object({ id: z.string(), field: z.string().optional(), displayName: z.string().optional() }),
  ),
  valueCols: z.array(
    z.object({
      id: z.string(),
      field: z.string().optional(),
      aggFunc: z.string().optional(),
      displayName: z.string().optional(),
    }),
  ),
  pivotMode: z.boolean().optional(),
  groupKeys: z.array(z.string()),
  sortModel: z.array(z.object({ colId: z.string(), sort: z.enum(['asc', 'desc']) })),
  filterModel: z.record(z.string(), z.unknown()).nullable().optional(),
});

/** Validates every message a client may send. The server never trusts the wire. */
export const clientMsgSchema: z.ZodType<ClientMsg> = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    traderId: z.string().min(1),
    codec: z.enum(['json', 'msgpack']),
    clientId: z.string().min(1),
  }),
  z.object({ t: z.literal('getRows'), reqId: nonNegInt, req: ssrmRequestSchema }),
  z.object({ t: z.literal('setFilterValues'), reqId: nonNegInt, colId: z.string().min(1) }),
  z.object({
    t: z.literal('command'),
    reqId: nonNegInt,
    orderId: z.string().min(1),
    action: z.enum(['CANCEL', 'PAUSE', 'RESUME']),
  }),
  z.object({ t: z.literal('ping'), ts: z.number() }),
]);

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseClientMsg(input: unknown): ParseResult<ClientMsg> {
  const result = clientMsgSchema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
}

/** Light structural check only; server messages are deliberately not schema-validated for speed. */
export function isServerMsg(input: unknown): input is ServerMsg {
  if (typeof input !== 'object' || input === null) return false;
  const t = (input as { t?: unknown }).t;
  return typeof t === 'string' && (SERVER_MSG_TYPES as readonly string[]).includes(t);
}
