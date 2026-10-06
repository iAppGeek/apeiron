import { generateOrders, type Order } from '@apeiron/logos';

export type Percentiles = { min: number; p1: number; p5: number; p25: number; p50: number; p75: number; p95: number; p99: number; max: number; mean: number };

export type Stats = {
  total: number;
  byStatus: Record<string, number>;
  byPair: Record<string, number>;
  byTrader: Record<string, number>;
  byAlgo: Record<string, number>;
  bySide: Record<string, number>;
  byOrderType: Record<string, number>;
  byVenue: Record<string, number>;
  byTenor: Record<string, number>;
  orderQty: Percentiles;
  notionalUsd: Percentiles;
  slippageBps: { mean: number; sd: number };
  londonHoursShare: number;
  firstCreatedAt: number;
  lastCreatedAt: number;
  weekendOrders: number;
  liveCount: number;
  pendingCount: number;
};

export function percentiles(values: Float64Array): Percentiles {
  if (values.length === 0) return { min: 0, p1: 0, p5: 0, p25: 0, p50: 0, p75: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const sorted = Float64Array.from(values).sort();
  const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    min: sorted[0] ?? 0,
    p1: at(1),
    p5: at(5),
    p25: at(25),
    p50: at(50),
    p75: at(75),
    p95: at(95),
    p99: at(99),
    max: sorted[sorted.length - 1] ?? 0,
    mean: sum / sorted.length,
  };
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export function computeStats(orders: Iterable<Order>, expected: number): Stats {
  const stats: Stats = {
    total: 0,
    byStatus: {},
    byPair: {},
    byTrader: {},
    byAlgo: {},
    bySide: {},
    byOrderType: {},
    byVenue: {},
    byTenor: {},
    orderQty: percentiles(new Float64Array(0)),
    notionalUsd: percentiles(new Float64Array(0)),
    slippageBps: { mean: 0, sd: 0 },
    londonHoursShare: 0,
    firstCreatedAt: Number.POSITIVE_INFINITY,
    lastCreatedAt: Number.NEGATIVE_INFINITY,
    weekendOrders: 0,
    liveCount: 0,
    pendingCount: 0,
  };
  const qty = new Float64Array(expected);
  const notional = new Float64Array(expected);
  let slipN = 0;
  let slipSum = 0;
  let slipSq = 0;
  let london = 0;
  let historical = 0;
  let i = 0;
  for (const o of orders) {
    qty[i] = o.orderQty;
    notional[i] = o.notionalUsd;
    i++;
    bump(stats.byStatus, o.status);
    bump(stats.byPair, o.currencyPair);
    bump(stats.byTrader, o.traderId);
    bump(stats.byAlgo, o.algoType);
    bump(stats.bySide, o.side);
    bump(stats.byOrderType, o.orderType);
    bump(stats.byVenue, o.venue);
    bump(stats.byTenor, o.tenor);
    if (o.status === 'LIVE') stats.liveCount++;
    if (o.status === 'PENDING_START') stats.pendingCount++;
    if (o.slippageBps !== null) {
      slipN++;
      slipSum += o.slippageBps;
      slipSq += o.slippageBps * o.slippageBps;
    }
    if (o.status === 'FILLED' || o.status === 'CANCELLED') {
      historical++;
      const d = new Date(o.createdAt);
      const h = d.getUTCHours();
      if (h >= 7 && h < 17) london++;
      const dow = d.getUTCDay();
      if (dow === 0 || dow === 6) stats.weekendOrders++;
    }
    stats.firstCreatedAt = Math.min(stats.firstCreatedAt, o.createdAt);
    stats.lastCreatedAt = Math.max(stats.lastCreatedAt, o.createdAt);
  }
  stats.total = i;
  stats.orderQty = percentiles(qty.subarray(0, i));
  stats.notionalUsd = percentiles(notional.subarray(0, i));
  const mean = slipN === 0 ? 0 : slipSum / slipN;
  stats.slippageBps = { mean, sd: slipN === 0 ? 0 : Math.sqrt(slipSq / slipN - mean * mean) };
  stats.londonHoursShare = historical === 0 ? 0 : london / historical;
  return stats;
}

export function generateStats(seed: number, n: number, now: number): Stats {
  return computeStats(generateOrders(seed, n, now), n);
}

const pct = (n: number, total: number): string => `${((n / total) * 100).toFixed(2)}%`;
const num = (n: number): string => Math.round(n).toLocaleString('en-US');

function table(title: string, counts: Record<string, number>, total: number): string {
  const rows = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `| ${k} | ${num(v)} | ${pct(v, total)} |`);
  return [`### ${title}`, '', '| value | count | share |', '|---|---:|---:|', ...rows, ''].join('\n');
}

function pctTable(title: string, p: Percentiles): string {
  return [
    `### ${title}`,
    '',
    '| min | p1 | p5 | p25 | p50 | p75 | p95 | p99 | max | mean |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    `| ${[p.min, p.p1, p.p5, p.p25, p.p50, p.p75, p.p95, p.p99, p.max, p.mean].map(num).join(' | ')} |`,
    '',
  ].join('\n');
}

export function formatStats(s: Stats): string {
  return [
    `Total rows: ${num(s.total)}; LIVE: ${s.liveCount}; PENDING_START: ${s.pendingCount}`,
    `createdAt range: ${new Date(s.firstCreatedAt).toISOString()} .. ${new Date(s.lastCreatedAt).toISOString()}`,
    `Historical orders created 07:00-17:00 UTC: ${(s.londonHoursShare * 100).toFixed(2)}%; on weekends: ${s.weekendOrders}`,
    `Slippage bps (filled orders): mean ${s.slippageBps.mean.toFixed(3)}, sd ${s.slippageBps.sd.toFixed(3)}`,
    '',
    table('Status', s.byStatus, s.total),
    table('Currency pair', s.byPair, s.total),
    table('Trader', s.byTrader, s.total),
    table('Algo', s.byAlgo, s.total),
    table('Side', s.bySide, s.total),
    table('Order type', s.byOrderType, s.total),
    table('Venue', s.byVenue, s.total),
    table('Tenor', s.byTenor, s.total),
    pctTable('Order quantity (base ccy)', s.orderQty),
    pctTable('Notional USD', s.notionalUsd),
  ].join('\n');
}
