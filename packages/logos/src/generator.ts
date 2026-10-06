import {
  ALGO_TYPES,
  ORDER_TYPES,
  PAIRS,
  TENORS,
  TIME_IN_FORCE,
  TRADER_SPECS,
  URGENCIES,
  VENUES,
  type AlgoType,
  type CurrencyPair,
  type Order,
  type OrderStatus,
  type OrderType,
  type PairInfo,
  type Side,
  type Tenor,
} from './order.js';
import { mulberry32, normal, pick, pickWeighted, pickWeightedIndex, uniform, type Rng } from './prng.js';

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;
const HISTORY_DAYS = 182;
const ID_PAD = 8;

/** Aligned with ALGO_TYPES: TWAP 30, VWAP 25, POV 15, ICEBERG 12, SNIPER 8, IS 10. */
const ALGO_WEIGHTS: readonly number[] = [30, 25, 15, 12, 8, 10];
const ORDER_TYPE_WEIGHTS: readonly number[] = [70, 20, 10];
const TIF_WEIGHTS: readonly number[] = [60, 5, 10, 25];
const URGENCY_WEIGHTS: readonly number[] = [25, 50, 25];
const VENUE_WEIGHTS: readonly number[] = [18, 16, 15, 12, 12, 10, 9, 8];
const TENOR_WEIGHTS: readonly number[] = [85, 5, 4, 4, 2];
const TRADER_WEIGHTS: readonly number[] = TRADER_SPECS.map((t) => t.weight);
const PAIR_WEIGHTS: readonly number[] = PAIRS.map((p) => p.weight);
/** London trading hours (07:00-17:00, approximated as UTC) carry 85% of flow. */
const HOUR_WEIGHTS: readonly number[] = Array.from({ length: 24 }, (_, h) => (h >= 7 && h < 17 ? 8.5 : 15 / 14));

export type GeneratorOptions = {
  seed: number;
  /** Total number of orders, including the current LIVE and PENDING_START ones. */
  n: number;
  /** Reference "now" in epoch ms. Pass a fixed value for reproducible data. */
  now: number;
  batchSize?: number;
};

export type CurrentCounts = { live: number; pending: number };

/** About 400 LIVE and 200 PENDING_START orders at 1M rows, scaled down for smaller datasets. */
export function currentOrderCounts(n: number): CurrentCounts {
  return {
    live: Math.min(400, Math.round(n * 0.0004)),
    pending: Math.min(200, Math.round(n * 0.0002)),
  };
}

type MidTable = Map<CurrencyPair, number>;

type Spec = {
  status: OrderStatus;
  createdAt: number;
  startTime: number;
  durationMins: number;
  /** Fraction of the order quantity filled, in [0, 1]. */
  fillFraction: number;
  completedAt: number | null;
  now: number;
  current: boolean;
};

const roundTo = (value: number, decimals: number): number => {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
};
const pad = (n: number): string => String(n).padStart(ID_PAD, '0');
const floorDay = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

function ccyToUsd(ccy: string, mids: MidTable): number {
  if (ccy === 'USD') return 1;
  const direct = mids.get(`${ccy}USD` as CurrencyPair);
  if (direct !== undefined) return direct;
  const inverse = mids.get(`USD${ccy}` as CurrencyPair);
  if (inverse !== undefined) return 1 / inverse;
  throw new Error(`No USD conversion for ${ccy}`);
}

function addBusinessDays(ms: number, days: number): number {
  let d = floorDay(ms);
  let left = days;
  while (left > 0) {
    d += DAY_MS;
    const dow = new Date(d).getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return d;
}

function rollToWeekday(ms: number): number {
  let d = floorDay(ms);
  while (new Date(d).getUTCDay() === 0 || new Date(d).getUTCDay() === 6) d += DAY_MS;
  return d;
}

function valueDateFor(tenor: Tenor, createdAt: number): number {
  switch (tenor) {
    case 'SPOT':
      return addBusinessDays(createdAt, 2);
    case 'TOM':
      return addBusinessDays(createdAt, 1);
    case '1W':
      return rollToWeekday(floorDay(createdAt) + 7 * DAY_MS);
    case '1M':
      return rollToWeekday(floorDay(createdAt) + 30 * DAY_MS);
    case '3M':
      return rollToWeekday(floorDay(createdAt) + 91 * DAY_MS);
  }
}

function strategyParamsFor(rng: Rng, algo: AlgoType, participation: number): string {
  switch (algo) {
    case 'TWAP':
      return `slices=${12 + Math.floor(rng() * 36)};randomize=${rng() < 0.5}`;
    case 'VWAP':
      return `profile=hist${rng() < 0.5 ? 20 : 60}d;maxPart=${Math.round(participation * 1.5)}%`;
    case 'POV':
      return `rate=${participation}%;maxPart=${Math.round(participation * 1.6)}%`;
    case 'ICEBERG':
      return `display=${(1 + Math.floor(rng() * 9)) * 100000};refresh=${rng() < 0.5 ? 'random' : 'fixed'}`;
    case 'SNIPER':
      return `aggr=${1 + Math.floor(rng() * 5)};liqSeek=${rng() < 0.7}`;
    case 'IS':
      return `riskAversion=${roundTo(0.1 + rng() * 0.8, 2)};horizon=${15 + Math.floor(rng() * 90)}m`;
  }
}

class OrderFactory {
  readonly mids: MidTable = new Map();
  seq = 0;

  constructor(private readonly rng: Rng) {
    for (const p of PAIRS) this.mids.set(p.pair, p.mid);
  }

  /** Advances every pair's mid by one day of random walk. */
  walkDay(): void {
    for (const p of PAIRS) {
      const mid = this.mids.get(p.pair) ?? p.mid;
      this.mids.set(p.pair, mid * Math.exp(normal(this.rng, 0, p.dailyVol)));
    }
  }

  private quantity(): number {
    const raw = Math.exp(normal(this.rng, Math.log(6_000_000), 0.9));
    return Math.min(100_000_000, Math.max(1_000_000, Math.round(raw / 100_000) * 100_000));
  }

  create(spec: Spec): Order {
    const rng = this.rng;
    const seq = ++this.seq;
    const trader = pickWeighted(rng, TRADER_SPECS, TRADER_WEIGHTS);
    const account = pick(rng, trader.accounts);
    const info: PairInfo = pickWeighted(rng, PAIRS, PAIR_WEIGHTS);
    const dec = info.decimals;
    const side: Side = rng() < 0.5 ? 'BUY' : 'SELL';
    const sign = side === 'BUY' ? 1 : -1;
    const algoType: AlgoType = ALGO_TYPES[pickWeightedIndex(rng, ALGO_WEIGHTS)] ?? 'TWAP';
    const orderType: OrderType = pickWeighted(rng, ORDER_TYPES, ORDER_TYPE_WEIGHTS);
    const timeInForce = pickWeighted(rng, TIME_IN_FORCE, TIF_WEIGHTS);
    const urgency = pickWeighted(rng, URGENCIES, URGENCY_WEIGHTS);
    const venue = pickWeighted(rng, VENUES, VENUE_WEIGHTS);
    const tenor = pickWeighted(rng, TENORS, TENOR_WEIGHTS);
    const participationRate = roundTo(algoType === 'POV' ? uniform(rng, 5, 25) : uniform(rng, 1, 15), 1);

    const orderQty = this.quantity();
    const dayMid = this.mids.get(info.pair) ?? info.mid;
    const arrivalPrice = roundTo(dayMid * (1 + normal(rng, 0, info.dailyVol * (spec.current ? 0.1 : 0.35))), dec);

    // Fills.
    let filledQty = 0;
    if (spec.fillFraction >= 1) filledQty = orderQty;
    else if (spec.fillFraction > 0) {
      filledQty = Math.min(orderQty - 1000, Math.max(1000, Math.round((orderQty * spec.fillFraction) / 1000) * 1000));
    }
    const hasFills = filledQty > 0;
    const slip = normal(rng, 0.5, 2);
    const avgFillPrice = hasFills ? roundTo(arrivalPrice * (1 + (sign * slip) / 1e4), dec) : null;

    // Market snapshot.
    const marketMid = spec.current
      ? roundTo(dayMid, dec)
      : roundTo(arrivalPrice * (1 + normal(rng, 0, info.dailyVol * 0.2)), dec);
    const spreadTarget = info.g10 ? uniform(rng, 0.5, 3) : uniform(rng, 5, 30);
    const marketBid = roundTo(marketMid * (1 - spreadTarget / 2e4), dec);
    const marketAsk = roundTo(marketMid * (1 + spreadTarget / 2e4), dec);
    const spreadBps = roundTo(((marketAsk - marketBid) / marketMid) * 1e4, 2);

    // Limit.
    let limitPrice: number | null = null;
    if (orderType === 'LIMIT') {
      limitPrice = roundTo(arrivalPrice * (1 + (sign * uniform(rng, 2, 17)) / 1e4), dec);
    } else if (orderType === 'PEGGED') {
      limitPrice = roundTo(arrivalPrice * (1 + (sign * uniform(rng, 0.5, 3.5)) / 1e4), dec);
    }
    const distanceToLimitBps =
      limitPrice === null ? null : roundTo((sign * (limitPrice - marketMid) * 1e4) / marketMid, 2);

    // USD conversion and performance.
    const baseUsd = ccyToUsd(info.base, this.mids);
    const quoteUsd = ccyToUsd(info.quote, this.mids);
    const notionalUsd = roundTo(orderQty * baseUsd, 2);
    const filledNotionalUsd = roundTo(filledQty * baseUsd, 2);
    const slippageBps =
      avgFillPrice === null ? null : roundTo((sign * (avgFillPrice - arrivalPrice) * 1e4) / arrivalPrice, 2);
    const slippageUsd = slippageBps === null ? 0 : roundTo((slippageBps / 1e4) * filledNotionalUsd, 2);
    const pnl =
      avgFillPrice === null ? 0 : roundTo(filledQty * sign * (marketMid - avgFillPrice) * quoteUsd, 2);
    const isOpen = spec.status === 'LIVE' || spec.status === 'PAUSED';
    const vwapBenchmark = hasFills ? roundTo(arrivalPrice * (1 + normal(rng, 0, 2) / 1e4), dec) : null;
    const perfVsVwapBps =
      avgFillPrice === null || vwapBenchmark === null
        ? null
        : roundTo((sign * (avgFillPrice - vwapBenchmark) * 1e4) / vwapBenchmark, 2);

    // Execution.
    const numFills = hasFills
      ? Math.max(1, 1 + Math.floor((spec.durationMins / 6) * uniform(rng, 0.4, 1.6) * Math.max(spec.fillFraction, 0.1)))
      : 0;
    const numChildOrders = hasFills ? numFills + Math.floor(rng() * numFills * 0.6) : 0;
    const lastFillQty = hasFills
      ? Math.min(filledQty, Math.max(1000, Math.round(((filledQty / numFills) * uniform(rng, 0.6, 1.4)) / 1000) * 1000))
      : 0;
    const lastFillPrice =
      avgFillPrice === null ? null : roundTo(avgFillPrice * (1 + normal(rng, 0, 0.5) / 1e4), dec);

    const endTime = spec.startTime + spec.durationMins * MIN_MS;
    const lastUpdateTime =
      spec.completedAt ??
      (spec.status === 'PENDING_START' ? spec.createdAt : Math.max(spec.startTime, spec.now - Math.floor(rng() * 60_000)));

    return {
      orderId: `ALG${pad(seq)}`,
      parentOrderId: `PAR${pad(seq)}`,
      clientOrderId: `CL-${trader.traderId}-${seq.toString(36).toUpperCase().padStart(7, '0')}`,
      traderId: trader.traderId,
      traderName: trader.traderName,
      account,
      currencyPair: info.pair,
      baseCcy: info.base,
      quoteCcy: info.quote,
      tenor,
      valueDate: valueDateFor(tenor, spec.createdAt),
      side,
      algoType,
      status: spec.status,
      orderType,
      timeInForce,
      urgency,
      venue,
      strategyParams: strategyParamsFor(rng, algoType, participationRate),
      orderQty,
      filledQty,
      remainingQty: orderQty - filledQty,
      pctComplete: roundTo((filledQty / orderQty) * 100, 2),
      notionalUsd,
      filledNotionalUsd,
      limitPrice,
      arrivalPrice,
      avgFillPrice,
      marketBid,
      marketAsk,
      marketMid,
      lastFillPrice,
      distanceToLimitBps,
      spreadBps,
      slippageBps,
      slippageUsd,
      unrealisedPnlUsd: isOpen ? pnl : 0,
      realisedPnlUsd: isOpen ? 0 : pnl,
      vwapBenchmark,
      perfVsVwapBps,
      numFills,
      numChildOrders,
      participationRate,
      lastFillQty,
      createdAt: spec.createdAt,
      startTime: spec.startTime,
      endTime,
      lastUpdateTime,
      completedAt: spec.completedAt,
      durationMins: spec.durationMins,
    };
  }
}

/** Weekdays (UTC) in the 182 days before today, oldest first. Today is excluded. */
export function historicalDays(now: number): number[] {
  const today = floorDay(now);
  const days: number[] = [];
  for (let i = HISTORY_DAYS; i >= 1; i--) {
    const d = today - i * DAY_MS;
    const dow = new Date(d).getUTCDay();
    if (dow !== 0 && dow !== 6) days.push(d);
  }
  return days;
}

function timeOfDayOffsets(rng: Rng, count: number): number[] {
  const offsets = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    const hour = pickWeightedIndex(rng, HOUR_WEIGHTS);
    offsets[i] = hour * 3_600_000 + Math.floor(rng() * 3_600_000);
  }
  offsets.sort((a, b) => a - b);
  return offsets;
}

function* historicalOrders(rng: Rng, factory: OrderFactory, count: number, now: number): Generator<Order> {
  const days = historicalDays(now);
  let produced = 0;
  for (let d = 0; d < days.length; d++) {
    factory.walkDay();
    const target = Math.floor((count * (d + 1)) / days.length);
    const todays = target - produced;
    const day = days[d] ?? 0;
    for (const offset of timeOfDayOffsets(rng, todays)) {
      const createdAt = day + offset;
      const drawnDuration = 5 + Math.floor(rng() ** 1.5 * 236);
      const startTime = Math.min(createdAt + Math.floor(rng() * 5 * MIN_MS), now - 2 * MIN_MS);
      // Historical orders must be finished by `now`; this only bites within hours of UTC midnight.
      const durationMins = Math.max(1, Math.min(drawnDuration, Math.floor((now - 1 - startTime) / MIN_MS)));
      const naturalEnd = startTime + durationMins * MIN_MS;
      const filled = rng() < 0.92;
      const fillFraction = filled ? 1 : uniform(rng, 0.05, 0.95);
      const frac = filled ? uniform(rng, 0.8, 1) : uniform(rng, 0.2, 1);
      const completedAt = Math.min(Math.round(startTime + durationMins * MIN_MS * frac), now - 1, naturalEnd);
      yield factory.create({
        status: filled ? 'FILLED' : 'CANCELLED',
        createdAt,
        startTime,
        durationMins,
        fillFraction,
        completedAt: Math.max(completedAt, startTime + 1),
        now,
        current: false,
      });
    }
    produced = target;
  }
}

function* currentOrders(rng: Rng, factory: OrderFactory, counts: CurrentCounts, now: number): Generator<Order> {
  for (let i = 0; i < counts.live; i++) {
    const durationMins = 20 + Math.floor(rng() * 221);
    const elapsed = uniform(rng, 0.05, 0.9);
    const startTime = now - Math.max(MIN_MS, Math.round(elapsed * durationMins * MIN_MS));
    const createdAt = startTime - Math.floor(rng() * 3 * MIN_MS);
    yield factory.create({
      status: 'LIVE',
      createdAt,
      startTime,
      durationMins,
      fillFraction: Math.min(0.97, elapsed * uniform(rng, 0.7, 1.1)),
      completedAt: null,
      now,
      current: true,
    });
  }
  for (let i = 0; i < counts.pending; i++) {
    const startTime = now + Math.floor(uniform(rng, 1, 120) * MIN_MS);
    yield factory.create({
      status: 'PENDING_START',
      createdAt: now - Math.floor(rng() * 30 * MIN_MS),
      startTime,
      durationMins: 20 + Math.floor(rng() * 221),
      fillFraction: 0,
      completedAt: null,
      now,
      current: true,
    });
  }
}

/**
 * Deterministic order stream: the same (seed, n, now) always yields the same orders.
 * Historical orders come first, ordered by createdAt, followed by the current LIVE and
 * PENDING_START orders, so order IDs increase monotonically through the stream.
 */
export function generateOrders(seed: number, n: number, now: number): Generator<Order> {
  return createStream(seed, n, now).orders;
}

type Stream = { orders: Generator<Order>; factory: OrderFactory };

function createStream(seed: number, n: number, now: number): Stream {
  const rng = mulberry32(seed);
  const factory = new OrderFactory(rng);
  const counts = currentOrderCounts(n);
  const historicalCount = Math.max(0, n - counts.live - counts.pending);
  function* all(): Generator<Order> {
    yield* historicalOrders(rng, factory, historicalCount, now);
    yield* currentOrders(rng, factory, counts, now);
  }
  return { orders: all(), factory };
}

/**
 * The price-walk level of every pair at the end of generation (unrounded). Every LIVE and PENDING_START
 * order's `marketMid` is `round(finalMids[pair], pairDecimals)`, so the price feed must start here, not
 * at `PAIRS.mid`. Replays the whole stream, so it costs about as much as generating the data.
 */
export function finalMids(seed: number, n: number, now: number): Record<CurrencyPair, number> {
  const { orders, factory } = createStream(seed, n, now);
  for (const _order of orders) {
    // draining the stream advances the walk to its final state
  }
  return Object.fromEntries(factory.mids) as Record<CurrencyPair, number>;
}

/** Streams the order set in batches (default 10,000) without materialising it. */
export function* generateOrderBatches(options: GeneratorOptions): Generator<Order[]> {
  const size = options.batchSize ?? 10_000;
  let batch: Order[] = [];
  for (const order of generateOrders(options.seed, options.n, options.now)) {
    batch.push(order);
    if (batch.length >= size) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}
