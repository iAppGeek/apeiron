import { ORDER_STATUSES, derivePriceFields, mulberry32, type Order, type SsrmRequest } from '@apeiron/logos';
import { QueryEngine } from '../query/engine.js';
import { ChangeSet } from '../query/changeset.js';
import { generateStore } from './dataset.js';

/**
 * Cost of patching cached views per flush tick on a 1M-row store: price-driven updates of LIVE rows plus a few new
 * orders, against views that sort by a ticking column (structural every tick), group, and filter.
 * Run with `pnpm --filter @apeiron/antikythera exec tsx src/testing/live-bench.ts`.
 */
const store = generateStore(1_000_000);
const engine = new QueryEngine(store, { maxViews: 64, maxBytes: 1 << 30, maxBlockRows: 5_000 });
const base: SsrmRequest = { startRow: 0, endRow: 100, rowGroupCols: [], valueCols: [], groupKeys: [], sortModel: [], filterModel: null };
const agg = [
  { id: 'notionalUsd', field: 'notionalUsd', aggFunc: 'sum' },
  { id: 'slippageBps', field: 'slippageBps', aggFunc: 'wavg' },
  { id: 'unrealisedPnlUsd', field: 'unrealisedPnlUsd', aggFunc: 'sum' },
];
const views: [string, string, SsrmRequest][] = [
  ['default flat ALL (createdAt desc)', 'ALL', base],
  ['default flat T1', 'T1', base],
  ['sort notionalUsd desc', 'ALL', { ...base, sortModel: [{ colId: 'notionalUsd', sort: 'desc' }] }],
  ['sort marketMid asc (ticking key)', 'ALL', { ...base, sortModel: [{ colId: 'marketMid', sort: 'asc' }] }],
  ['sort clientOrderId asc (string)', 'ALL', { ...base, sortModel: [{ colId: 'clientOrderId', sort: 'asc' }] }],
  ['filter LIVE, sort unrealisedPnlUsd desc', 'ALL', { ...base, filterModel: { status: { filterType: 'set', values: ['LIVE'] } }, sortModel: [{ colId: 'unrealisedPnlUsd', sort: 'desc' }] }],
  ['group currencyPair, aggs', 'ALL', { ...base, rowGroupCols: [{ id: 'currencyPair', field: 'currencyPair' }], valueCols: agg as SsrmRequest['valueCols'] }],
  ['group status > currencyPair, aggs, sort by agg', 'ALL', { ...base, rowGroupCols: [{ id: 'status', field: 'status' }, { id: 'currencyPair', field: 'currencyPair' }], valueCols: agg as SsrmRequest['valueCols'], sortModel: [{ colId: 'unrealisedPnlUsd', sort: 'desc' }] }],
];
const t0 = performance.now();
for (const [, trader, req] of views) {
  const r = engine.getRows(trader, req);
  if (!r.ok) throw new Error(r.code);
}
// Materialise nested routes too.
engine.getRows('ALL', { ...(views[7] as [string, string, SsrmRequest])[2], groupKeys: ['LIVE'] });
engine.getRows('ALL', { ...(views[7] as [string, string, SsrmRequest])[2], groupKeys: ['LIVE', 'EURUSD'], rowGroupCols: (views[7] as [string, string, SsrmRequest])[2].rowGroupCols });
console.log(`built ${views.length} views in ${Math.round(performance.now() - t0)}ms`);

const statusCol = store.enumColumn('status');
const live: number[] = [];
for (let i = 0; i < store.size; i++) if (statusCol.dict.values[statusCol.codes[i] as number] === 'LIVE') live.push(i);
console.log(`LIVE rows: ${live.length}, statuses: ${ORDER_STATUSES.length}`);

const rng = mulberry32(5);
let nextId = 2_000_000_000;
const perTick = Number(process.argv[2] ?? 1500);
const times: number[] = [];
const storeTimes: number[] = [];
for (let tick = 0; tick < 100; tick++) {
  const s0 = performance.now();
  const cs = new ChangeSet();
  for (let i = 0; i < perTick; i++) {
    const row = live[Math.floor(rng() * live.length)] as number;
    const o = store.orderAt(row);
    const mid = o.marketMid * (1 + (rng() - 0.5) * 1e-4);
    const changes = derivePriceFields(o, { bid: mid * 0.99999, ask: mid * 1.00001 }, 1_800_000_000_000 + tick);
    const { changed, prev } = store.updateRow(row, changes);
    cs.noteUpdate(row, changed, prev);
  }
  for (let i = 0; i < 5; i++) {
    const o: Order = { ...store.orderAt(live[0] as number), orderId: `ALG${String(nextId++).padStart(10, '0')}`, createdAt: 1_800_000_000_000 + tick * 100 + i, status: 'LIVE' };
    const r = store.upsert(o);
    if (r.kind === 'append') {
      cs.noteNew(r.row);
      live.push(r.row);
    }
  }
  const s1 = performance.now();
  engine.applyChanges(cs);
  times.push(performance.now() - s1);
  storeTimes.push(s1 - s0);
}
const pct = (xs: number[], p: number): number => [...xs].sort((a, b) => a - b)[Math.floor((p / 100) * xs.length)] as number;
console.log(`per tick: ${perTick} price-style row updates + 5 new orders against ${engine.stats().cache.views} cached views`);
console.log(`applyChanges ms: p50 ${pct(times, 50).toFixed(2)} p95 ${pct(times, 95).toFixed(2)} max ${Math.max(...times).toFixed(2)}`);
console.log(`store writes ms (incl. price maths): p50 ${pct(storeTimes, 50).toFixed(2)} max ${Math.max(...storeTimes).toFixed(2)}`);
console.log(`view memory: ${Math.round(engine.stats().cache.bytes / 1048576)} MB, fallback rebuilds: ${[...engine.views()].reduce((a, v) => a + v.rebuiltAfterInconsistency, 0)}`);
