import type { SsrmRequest } from '@apeiron/logos';
import { test } from 'vitest';
import { QueryEngine } from '../src/query/engine.js';
import { generateStore } from '../src/testing/dataset.js';

/**
 * Engine benchmarks on 1,000,000 rows of real generator data (same seed and distributions as the
 * seeded database). "cold" clears every cached view before each iteration; "warm" hits a cached view.
 */
const store = generateStore(1_000_000);
const engine = new QueryEngine(store, { maxViews: 64, maxBytes: 512 * 1024 * 1024, maxBlockRows: 5_000 });

const flat: SsrmRequest = {
  startRow: 0,
  endRow: 100,
  rowGroupCols: [],
  valueCols: [],
  groupKeys: [],
  sortModel: [],
  filterModel: null,
};

const selective: SsrmRequest = {
  ...flat,
  filterModel: {
    currencyPair: { filterType: 'set', values: ['EURUSD'] },
    status: { filterType: 'set', values: ['FILLED'] },
    orderQty: { filterType: 'number', type: 'greaterThan', filter: 5_000_000 },
  },
  sortModel: [{ colId: 'notionalUsd', sort: 'desc' }],
};

const multiSort: SsrmRequest = {
  ...flat,
  sortModel: [
    { colId: 'venue', sort: 'asc' },
    { colId: 'algoType', sort: 'desc' },
    { colId: 'notionalUsd', sort: 'desc' },
  ],
};

const oneLevel: SsrmRequest = {
  ...flat,
  rowGroupCols: [{ id: 'currencyPair' }],
  valueCols: [
    { id: 'notionalUsd', aggFunc: 'sum' },
    { id: 'slippageBps', aggFunc: 'wavg' },
    { id: 'orderQty', aggFunc: 'avg' },
    { id: 'numFills', aggFunc: 'count' },
  ],
};

const twoLevel: SsrmRequest = {
  ...oneLevel,
  rowGroupCols: [{ id: 'currencyPair' }, { id: 'algoType' }],
  groupKeys: ['EURUSD'],
};

const run = (trader: string, req: SsrmRequest): void => {
  const r = engine.getRows(trader, req);
  if (!r.ok) throw new Error(r.code);
};
const cold = { beforeEach: (): void => engine.clearCaches() };
const COLD = { iterations: 15 };
const WARM = { iterations: 2_000 };

test('cold: default view (createdAt desc, 1M rows)', async ({ bench }) => {
  await bench('cold default view', cold, () => run('ALL', flat)).run(COLD);
});

test('cold: selective filter + sort', async ({ bench }) => {
  await bench('cold selective filter + sort', cold, () => run('T1', selective)).run(COLD);
});

test('cold: three-column sort over all rows', async ({ bench }) => {
  await bench('cold multi-column sort', cold, () => run('ALL', multiSort)).run(COLD);
});

test('cold: one-level group with four aggregates', async ({ bench }) => {
  await bench('cold one-level group', cold, () => run('ALL', oneLevel)).run(COLD);
});

test('cold: two-level group (expand EURUSD)', async ({ bench }) => {
  await bench('cold two-level group', cold, () => run('ALL', twoLevel)).run(COLD);
});

test('cold: setFilterValues for a trader', async ({ bench }) => {
  await bench('cold setFilterValues', cold, () => engine.setFilterValues('T1', 'currencyPair')).run({ iterations: 100 });
});

test('warm: block fetch of 100 rows from a cached view', async ({ bench }) => {
  run('ALL', flat);
  let start = 0;
  await bench('warm block fetch (100 rows, scrolling)', () => {
    start = (start + 100_000 + 7_300) % 999_000;
    run('ALL', { ...flat, startRow: start, endRow: start + 100 });
  }).run(WARM);
});

test('warm: group and leaf blocks from cached views', async ({ bench }) => {
  run('ALL', oneLevel);
  run('ALL', twoLevel);
  await bench('warm one-level group block', () => run('ALL', oneLevel)).run(WARM);
  await bench('warm two-level group block', () => run('ALL', twoLevel)).run(WARM);
  run('ALL', selective);
  await bench('warm selective filter + sort block', () => run('T1', selective)).run(WARM);
});

test('warm: setFilterValues', async ({ bench }) => {
  engine.setFilterValues('T1', 'currencyPair');
  await bench('warm setFilterValues', () => engine.setFilterValues('T1', 'currencyPair')).run(WARM);
});
