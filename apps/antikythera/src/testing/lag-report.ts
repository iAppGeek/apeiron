import type { SsrmRequest } from '@apeiron/logos';
import { QueryEngine } from '../query/engine.js';
import { LagMonitor, withLagReport } from '../lag.js';
import { generateStore } from './dataset.js';

/**
 * Event-loop lag during cold 1M-row view builds, on real generator data. Each scenario is one
 * synchronous getRows, so its stall equals its duration; the lag histogram confirms it. Run with
 * `pnpm --filter @apeiron/antikythera lag-report`.
 */
const store = generateStore(1_000_000);
const engine = new QueryEngine(store, { maxViews: 64, maxBytes: 512 * 1024 * 1024, maxBlockRows: 5_000 });
const monitor = new LagMonitor(10);
monitor.start();

const flat: SsrmRequest = {
  startRow: 0,
  endRow: 100,
  rowGroupCols: [],
  valueCols: [],
  groupKeys: [],
  sortModel: [],
  filterModel: null,
};
const sorted = (colId: string, sort: 'asc' | 'desc' = 'asc'): SsrmRequest => ({ ...flat, sortModel: [{ colId, sort }] });

const scenarios: [string, string, SsrmRequest][] = [
  ['default view (createdAt desc)', 'ALL', flat],
  ['sort notionalUsd desc', 'ALL', sorted('notionalUsd', 'desc')],
  ['sort venue, algoType, notionalUsd', 'ALL', { ...flat, sortModel: [{ colId: 'venue', sort: 'asc' }, { colId: 'algoType', sort: 'desc' }, { colId: 'notionalUsd', sort: 'desc' }] }],
  ['sort strategyParams (first use: builds string ranks)', 'ALL', sorted('strategyParams')],
  ['sort strategyParams (ranks cached)', 'ALL', sorted('strategyParams', 'desc')],
  ['sort clientOrderId (first use: 1M unique strings)', 'ALL', sorted('clientOrderId')],
  ['sort clientOrderId (ranks cached)', 'ALL', sorted('clientOrderId', 'desc')],
  ['group currencyPair (4 aggs)', 'ALL', { ...flat, rowGroupCols: [{ id: 'currencyPair' }], valueCols: [{ id: 'notionalUsd', aggFunc: 'sum' }, { id: 'slippageBps', aggFunc: 'wavg' }, { id: 'orderQty', aggFunc: 'avg' }, { id: 'numFills', aggFunc: 'count' }] }],
  ['group status, expand FILLED (leaf sort of 920k rows)', 'ALL', { ...flat, rowGroupCols: [{ id: 'status' }], groupKeys: ['FILLED'] }],
  ['selective filter + sort (T1)', 'T1', { ...sorted('notionalUsd', 'desc'), filterModel: { currencyPair: { filterType: 'set', values: ['EURUSD'] }, status: { filterType: 'set', values: ['FILLED'] }, orderQty: { filterType: 'number', type: 'greaterThan', filter: 5_000_000 } } }],
  ['text filter contains (clientOrderId) + sort', 'ALL', { ...sorted('notionalUsd', 'desc'), filterModel: { clientOrderId: { filterType: 'text', type: 'contains', filter: '123' } } }],
];

console.log(`rows ${store.size}; lag figures are ms beyond the 10 ms sampling interval`);
console.log(`${'scenario'.padEnd(58)} ${'build ms'.padStart(9)} ${'lag p50'.padStart(8)} ${'lag p99'.padStart(8)} ${'lag max'.padStart(8)}`);
for (const [name, trader, req] of scenarios) {
  engine.clearCaches();
  const { result, lag } = await withLagReport(monitor, () => {
    const r = engine.getRows(trader, req);
    if (!r.ok) throw new Error(r.code);
    return r.value;
  });
  console.log(`${name.padEnd(58)} ${result.ms.toFixed(1).padStart(9)} ${String(lag.p50).padStart(8)} ${String(lag.p99).padStart(8)} ${String(lag.max).padStart(8)}`);
}
monitor.stop();
