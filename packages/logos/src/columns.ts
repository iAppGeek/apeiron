import type { OrderField } from './order.js';

export type ColumnType = 'string' | 'enum' | 'number' | 'datetime' | 'date';
export type FilterKind = 'text' | 'set' | 'number' | 'date';
export type AggFunc = 'sum' | 'avg' | 'wavg:notionalUsd' | 'count';

export type ColumnMeta = {
  field: OrderField;
  header: string;
  type: ColumnType;
  filter: FilterKind;
  groupable: boolean;
  aggFunc?: AggFunc;
  decimals?: number;
  width?: number;
  /** Price columns flash up/down on change. */
  priceColumn?: boolean;
};

type Opts = Partial<Omit<ColumnMeta, 'field' | 'header' | 'type' | 'filter'>>;

const str = (field: OrderField, header: string, opts: Opts = {}): ColumnMeta => ({
  field,
  header,
  type: 'string',
  filter: 'text',
  groupable: false,
  ...opts,
});
const en = (field: OrderField, header: string, opts: Opts = {}): ColumnMeta => ({
  field,
  header,
  type: 'enum',
  filter: 'set',
  groupable: false,
  ...opts,
});
const num = (field: OrderField, header: string, decimals: number, opts: Opts = {}): ColumnMeta => ({
  field,
  header,
  type: 'number',
  filter: 'number',
  groupable: false,
  decimals,
  ...opts,
});
const dt = (field: OrderField, header: string, opts: Opts = {}): ColumnMeta => ({
  field,
  header,
  type: 'datetime',
  filter: 'date',
  groupable: false,
  width: 160,
  ...opts,
});

/** The single source of truth for the 50 blotter columns (server engine and client grid). */
export const COLUMNS: readonly ColumnMeta[] = [
  // Identity (6)
  str('orderId', 'Order ID', { width: 130 }),
  str('parentOrderId', 'Parent ID', { width: 130 }),
  str('clientOrderId', 'Client Order ID', { width: 150 }),
  en('traderId', 'Trader ID', { width: 100 }),
  en('traderName', 'Trader', { groupable: true, width: 140 }),
  en('account', 'Account', { groupable: true, width: 120 }),
  // Instrument (5)
  en('currencyPair', 'Pair', { groupable: true, width: 100 }),
  en('baseCcy', 'Base', { groupable: true, width: 80 }),
  en('quoteCcy', 'Quote', { groupable: true, width: 80 }),
  en('tenor', 'Tenor', { groupable: true, width: 80 }),
  { field: 'valueDate', header: 'Value Date', type: 'date', filter: 'date', groupable: true, width: 120 },
  // Order (8)
  en('side', 'Side', { groupable: true, width: 80 }),
  en('algoType', 'Algo', { groupable: true, width: 100 }),
  en('status', 'Status', { groupable: true, width: 130 }),
  en('orderType', 'Order Type', { groupable: true, width: 110 }),
  en('timeInForce', 'TIF', { groupable: true, width: 80 }),
  en('urgency', 'Urgency', { groupable: true, width: 100 }),
  en('venue', 'Venue', { groupable: true, width: 110 }),
  str('strategyParams', 'Strategy Params', { width: 240 }),
  // Quantity (6)
  num('orderQty', 'Order Qty', 0, { aggFunc: 'sum', width: 130 }),
  num('filledQty', 'Filled Qty', 0, { aggFunc: 'sum', width: 130 }),
  num('remainingQty', 'Remaining Qty', 0, { width: 130 }),
  num('pctComplete', '% Complete', 2, { aggFunc: 'wavg:notionalUsd', width: 110 }),
  num('notionalUsd', 'Notional USD', 2, { aggFunc: 'sum', width: 150 }),
  num('filledNotionalUsd', 'Filled Notional USD', 2, { aggFunc: 'sum', width: 160 }),
  // Price (9)
  num('limitPrice', 'Limit Price', 5, { priceColumn: true }),
  num('arrivalPrice', 'Arrival Price', 5, { priceColumn: true }),
  num('avgFillPrice', 'Avg Fill Price', 5, { priceColumn: true }),
  num('marketBid', 'Bid', 5, { priceColumn: true }),
  num('marketAsk', 'Ask', 5, { priceColumn: true }),
  num('marketMid', 'Mid', 5, { priceColumn: true }),
  num('lastFillPrice', 'Last Fill Price', 5, { priceColumn: true }),
  num('distanceToLimitBps', 'Dist to Limit (bps)', 2),
  num('spreadBps', 'Spread (bps)', 2),
  // Performance (6)
  num('slippageBps', 'Slippage (bps)', 2, { aggFunc: 'wavg:notionalUsd' }),
  num('slippageUsd', 'Slippage USD', 2, { aggFunc: 'sum' }),
  num('unrealisedPnlUsd', 'Unrealised P&L USD', 2, { aggFunc: 'sum', width: 160 }),
  num('realisedPnlUsd', 'Realised P&L USD', 2, { aggFunc: 'sum', width: 150 }),
  num('vwapBenchmark', 'VWAP Benchmark', 5, { priceColumn: true }),
  num('perfVsVwapBps', 'Perf vs VWAP (bps)', 2, { aggFunc: 'wavg:notionalUsd', width: 150 }),
  // Execution (4)
  num('numFills', 'Fills', 0, { aggFunc: 'sum', width: 90 }),
  num('numChildOrders', 'Child Orders', 0, { width: 110 }),
  num('participationRate', 'Participation %', 1, { width: 120 }),
  num('lastFillQty', 'Last Fill Qty', 0),
  // Time (6)
  dt('createdAt', 'Created'),
  dt('startTime', 'Start'),
  dt('endTime', 'End'),
  dt('lastUpdateTime', 'Last Update'),
  dt('completedAt', 'Completed'),
  num('durationMins', 'Duration (min)', 0, { width: 120 }),
];

export const COLUMN_BY_FIELD: ReadonlyMap<OrderField, ColumnMeta> = new Map(
  COLUMNS.map((c): [OrderField, ColumnMeta] => [c.field, c]),
);

export const GROUPABLE_FIELDS: readonly OrderField[] = COLUMNS.filter((c) => c.groupable).map(
  (c): OrderField => c.field,
);

/** Identifier-like columns that always use a text filter instead of a set filter. */
export const FREE_TEXT_FIELDS: readonly OrderField[] = ['orderId', 'parentOrderId', 'clientOrderId'];

/** Cheap deterministic fingerprint of the column list (FNV-1a), sent in `welcome.columnsVersion`. */
export function computeColumnsVersion(columns: readonly ColumnMeta[]): string {
  let hash = 0x811c9dc5;
  for (const ch of JSON.stringify(columns)) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export const COLUMNS_VERSION: string = computeColumnsVersion(COLUMNS);
