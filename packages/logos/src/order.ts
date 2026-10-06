export const ORDER_STATUSES = ['PENDING_START', 'LIVE', 'PAUSED', 'FILLED', 'CANCELLED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const SIDES = ['BUY', 'SELL'] as const;
export type Side = (typeof SIDES)[number];

export const ALGO_TYPES = ['TWAP', 'VWAP', 'POV', 'ICEBERG', 'SNIPER', 'IS'] as const;
export type AlgoType = (typeof ALGO_TYPES)[number];

export const ORDER_TYPES = ['LIMIT', 'MARKET', 'PEGGED'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const TIME_IN_FORCE = ['DAY', 'GTC', 'IOC', 'GTD'] as const;
export type TimeInForce = (typeof TIME_IN_FORCE)[number];

export const URGENCIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type Urgency = (typeof URGENCIES)[number];

export const VENUES = [
  'LMAX',
  'EBS',
  'REFINITIV',
  'HOTSPOT',
  'CURRENEX',
  'FXALL',
  'BLOOMBERG',
  'INTERNAL',
] as const;
export type Venue = (typeof VENUES)[number];

export const TENORS = ['SPOT', 'TOM', '1W', '1M', '3M'] as const;
export type Tenor = (typeof TENORS)[number];

export const CURRENCY_PAIRS = [
  'EURUSD',
  'GBPUSD',
  'USDJPY',
  'AUDUSD',
  'USDCAD',
  'USDCHF',
  'NZDUSD',
  'EURGBP',
  'EURJPY',
  'GBPJPY',
  'EURCHF',
  'AUDJPY',
  'USDSEK',
  'USDNOK',
  'USDMXN',
  'USDZAR',
  'USDSGD',
  'USDHKD',
  'USDCNH',
  'USDTRY',
] as const;
export type CurrencyPair = (typeof CURRENCY_PAIRS)[number];

/**
 * A single FX algo order: exactly 50 fields. Timestamps and dates are epoch milliseconds (UTC);
 * `valueDate` is UTC midnight. Fields that do not apply yet (for example the average fill price of
 * an order with no fills) are `null`.
 */
export type Order = {
  // Identity (6)
  orderId: string;
  parentOrderId: string;
  clientOrderId: string;
  traderId: string;
  traderName: string;
  account: string;
  // Instrument (5)
  currencyPair: CurrencyPair;
  baseCcy: string;
  quoteCcy: string;
  tenor: Tenor;
  valueDate: number;
  // Order (8)
  side: Side;
  algoType: AlgoType;
  status: OrderStatus;
  orderType: OrderType;
  timeInForce: TimeInForce;
  urgency: Urgency;
  venue: Venue;
  strategyParams: string;
  // Quantity (6)
  orderQty: number;
  filledQty: number;
  remainingQty: number;
  pctComplete: number;
  notionalUsd: number;
  filledNotionalUsd: number;
  // Price (9)
  limitPrice: number | null;
  arrivalPrice: number;
  avgFillPrice: number | null;
  marketBid: number;
  marketAsk: number;
  marketMid: number;
  lastFillPrice: number | null;
  distanceToLimitBps: number | null;
  spreadBps: number;
  // Performance (6)
  slippageBps: number | null;
  slippageUsd: number;
  unrealisedPnlUsd: number;
  realisedPnlUsd: number;
  vwapBenchmark: number | null;
  perfVsVwapBps: number | null;
  // Execution (4)
  numFills: number;
  numChildOrders: number;
  participationRate: number;
  lastFillQty: number;
  // Time (6)
  createdAt: number;
  startTime: number;
  endTime: number;
  lastUpdateTime: number;
  completedAt: number | null;
  durationMins: number;
};

export type OrderField = keyof Order;

export type TraderInfo = {
  traderId: string;
  traderName: string;
};

export type PairInfo = {
  pair: CurrencyPair;
  base: string;
  quote: string;
  /** Reference mid level used to seed the random walk. */
  mid: number;
  decimals: number;
  /** Share of order flow (sums to 1 across all pairs). */
  weight: number;
  /** Typical daily volatility as a fraction (0.0045 = 0.45%). */
  dailyVol: number;
  /** G10 pairs get tight spreads, the rest wide ones. */
  g10: boolean;
};

export type TraderSpec = TraderInfo & {
  /** Share of order flow (sums to 1). */
  weight: number;
  accounts: readonly string[];
};

export const TRADER_SPECS: readonly TraderSpec[] = [
  { traderId: 'T1', traderName: 'Alice Marlowe', weight: 0.35, accounts: ['T1-ACC-1', 'T1-ACC-2', 'T1-ACC-3'] },
  { traderId: 'T2', traderName: 'Ben Okafor', weight: 0.25, accounts: ['T2-ACC-1', 'T2-ACC-2', 'T2-ACC-3'] },
  { traderId: 'T3', traderName: 'Chloe Tanaka', weight: 0.2, accounts: ['T3-ACC-1', 'T3-ACC-2', 'T3-ACC-3'] },
  { traderId: 'T4', traderName: 'Diego Ramirez', weight: 0.12, accounts: ['T4-ACC-1', 'T4-ACC-2', 'T4-ACC-3'] },
  { traderId: 'T5', traderName: 'Elena Voss', weight: 0.08, accounts: ['T5-ACC-1', 'T5-ACC-2', 'T5-ACC-3'] },
];

export const TRADERS: readonly TraderInfo[] = TRADER_SPECS.map(
  ({ traderId, traderName }): TraderInfo => ({ traderId, traderName }),
);

const NAMED_WEIGHTS: Partial<Record<CurrencyPair, number>> = {
  EURUSD: 0.25,
  USDJPY: 0.15,
  GBPUSD: 0.12,
  AUDUSD: 0.07,
  USDCAD: 0.06,
};
const NAMED_TOTAL = 0.65;

type PairSeed = readonly [CurrencyPair, number, number, number, boolean];

/** [pair, mid, decimals, dailyVol, g10] */
const PAIR_SEEDS: readonly PairSeed[] = [
  ['EURUSD', 1.08, 5, 0.0045, true],
  ['GBPUSD', 1.27, 5, 0.005, true],
  ['USDJPY', 150, 3, 0.0055, true],
  ['AUDUSD', 0.66, 5, 0.006, true],
  ['USDCAD', 1.36, 5, 0.004, true],
  ['USDCHF', 0.88, 5, 0.0045, true],
  ['NZDUSD', 0.61, 5, 0.0065, true],
  ['EURGBP', 0.85, 5, 0.0035, true],
  ['EURJPY', 162, 3, 0.0055, true],
  ['GBPJPY', 190, 3, 0.0065, true],
  ['EURCHF', 0.95, 5, 0.003, true],
  ['AUDJPY', 99, 3, 0.0065, true],
  ['USDSEK', 10.5, 4, 0.006, true],
  ['USDNOK', 10.7, 4, 0.006, true],
  ['USDMXN', 17.2, 4, 0.008, false],
  ['USDZAR', 18.6, 4, 0.009, false],
  ['USDSGD', 1.34, 5, 0.0025, false],
  ['USDHKD', 7.82, 5, 0.0004, false],
  ['USDCNH', 7.25, 4, 0.0025, false],
  ['USDTRY', 32, 4, 0.012, false],
];

const REMAINING_PAIRS = PAIR_SEEDS.filter(([pair]) => NAMED_WEIGHTS[pair] === undefined).length;

export const PAIRS: readonly PairInfo[] = PAIR_SEEDS.map(
  ([pair, mid, decimals, dailyVol, g10]): PairInfo => ({
    pair,
    base: pair.slice(0, 3),
    quote: pair.slice(3),
    mid,
    decimals,
    weight: NAMED_WEIGHTS[pair] ?? (1 - NAMED_TOTAL) / REMAINING_PAIRS,
    dailyVol,
    g10,
  }),
);

export const PAIR_BY_NAME: ReadonlyMap<CurrencyPair, PairInfo> = new Map(
  PAIRS.map((p): [CurrencyPair, PairInfo] => [p.pair, p]),
);
