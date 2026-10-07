import { mulberry32, type Order, type OrderField, type Rng, type Row, type SsrmRequest } from '@apeiron/logos';
import { describe, expect, it } from 'vitest';
import { propertyOrders, storeFrom } from '../testing/dataset.js';
import { randomRequest } from '../testing/request-gen.js';
import { ChangeSet } from './changeset.js';
import { QueryEngine, type EngineOptions } from './engine.js';
import type { ColumnarStore } from '../store/columnar-store.js';

/**
 * The most important engine test: apply seeded random ChangeSets to cached views incrementally and require
 * the result to equal a view built from scratch on the same store. Covers value-only updates, sort-key
 * changes, filter-membership flips, group-key changes, appends and dictionary growth, over flat and
 * 1-3 level grouped views with assorted sorts and filters (including string sorts).
 */

const ROWS = 1_200;
const BIG = 100_000;
const opts = (extra: Partial<EngineOptions> = {}): EngineOptions => ({ maxViews: 500, maxBytes: 1 << 30, maxBlockRows: BIG, patchUnsubscribed: true, deferRebuilds: false, ...extra });

const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T;

const NUMERIC: readonly OrderField[] = [
  'filledQty', 'orderQty', 'notionalUsd', 'marketMid', 'unrealisedPnlUsd', 'realisedPnlUsd', 'slippageBps',
  'perfVsVwapBps', 'pctComplete', 'numFills', 'lastUpdateTime', 'createdAt', 'limitPrice', 'distanceToLimitBps', 'spreadBps',
];
const NULLABLE = new Set<OrderField>(['slippageBps', 'perfVsVwapBps', 'limitPrice', 'distanceToLimitBps']);
const ENUM_VALUES: Partial<Record<OrderField, readonly string[]>> = {
  status: ['PENDING_START', 'LIVE', 'PAUSED', 'FILLED', 'CANCELLED'],
  side: ['BUY', 'SELL'],
  venue: ['LMAX', 'EBS', 'REFINITIV', 'HOTSPOT', 'CURRENEX', 'FXALL', 'BLOOMBERG', 'INTERNAL'],
  algoType: ['TWAP', 'VWAP', 'POV', 'ICEBERG', 'SNIPER', 'IS'],
  currencyPair: ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD'],
  account: ['T1-ACC-1', 'T2-ACC-2', 'T3-ACC-3'],
  tenor: ['SPOT', 'TOM', '1W', '1M', '3M'],
  urgency: ['LOW', 'MEDIUM', 'HIGH'],
  traderId: ['T1', 'T2', 'T3', 'T4', 'T5'],
  traderName: ['Alice Marlowe', 'Ben Okafor', 'Chloe Tanaka'],
};
const ENUM_FIELDS = Object.keys(ENUM_VALUES) as OrderField[];
const STRING_FIELDS: readonly OrderField[] = ['strategyParams', 'clientOrderId', 'parentOrderId'];
const DAY = 86_400_000;

type World = { store: ColumnarStore; rng: Rng; nextId: number; newWords: number; ids: string[] };

function randomValue(w: World, field: OrderField): unknown {
  const { rng } = w;
  if (NUMERIC.includes(field) || field === 'valueDate') {
    if (field === 'valueDate') return rng() < 0.15 ? null : Date.UTC(2026, 3, 1) + Math.floor(rng() * 40) * DAY;
    if (NULLABLE.has(field) && rng() < 0.15) return null;
    if (field === 'createdAt') return 1_700_000_000_000 + Math.floor(rng() * 1e10);
    // A small value set makes ties (and therefore the orderId tiebreak) common.
    return rng() < 0.3 ? Math.floor(rng() * 5) * 1000 : Math.round(rng() * 1e7) / 100;
  }
  if (STRING_FIELDS.includes(field)) return rng() < 0.5 ? `S${Math.floor(rng() * 30)}` : `s-${Math.floor(rng() * 1e6)}`;
  const base = ENUM_VALUES[field] as readonly string[];
  if (rng() < 0.03 && w.newWords < 25) return `NEW-${field}-${w.newWords++}`;
  return pick(rng, base);
}

const FIELD_POOL: readonly OrderField[] = [...NUMERIC, 'valueDate', ...ENUM_FIELDS, ...STRING_FIELDS];

/** One tick: a random mix of updates (some on the same row twice) and appends, recorded like a flush. */
function randomTick(w: World): ChangeSet {
  const { store, rng } = w;
  const cs = new ChangeSet();
  const count = 1 + Math.floor(rng() * (rng() < 0.1 ? 150 : 25));
  for (let i = 0; i < count; i++) {
    const roll = rng();
    if (roll < 0.12) {
      const template = store.orderAt(Math.floor(rng() * store.size));
      const order: Order = { ...template, orderId: `ALG${String(w.nextId++).padStart(8, '0')}`, createdAt: 1_900_000_000_000 + w.nextId };
      for (let k = 0; k < 1 + Math.floor(rng() * 4); k++) {
        const f = pick(rng, FIELD_POOL);
        (order as Record<string, unknown>)[f] = randomValue(w, f);
      }
      const result = store.upsert(order);
      if (result.kind === 'append') cs.noteNew(result.row);
      else cs.noteUpdate(result.row, result.changed, result.prev);
      w.ids.push(order.orderId);
      continue;
    }
    const row = Math.floor(rng() * store.size);
    const repeats = rng() < 0.2 ? 2 : 1;
    for (let r = 0; r < repeats; r++) {
      const partial: Record<string, unknown> = {};
      for (let k = 0; k < 1 + Math.floor(rng() * 3); k++) {
        const f = pick(rng, FIELD_POOL);
        partial[f] = randomValue(w, f);
      }
      const { changed, prev } = store.updateRow(row, partial as Partial<Order>);
      const isNewRow = cs.entries.get(row)?.isNew === true;
      if (isNewRow) cs.noteNew(row);
      else cs.noteUpdate(row, changed, prev);
    }
  }
  return cs;
}

type Probe = { traderId: string; req: SsrmRequest; label: string };

function approx(a: unknown, e: unknown): boolean {
  if (typeof a === 'number' && typeof e === 'number') return Math.abs(a - e) <= 1e-6 + 1e-9 * Math.abs(e);
  return a === e;
}

function expectSameRows(actual: Row[], expected: Row[], grouped: boolean, label: string): void {
  expect(actual.length, label).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i] as Row;
    const e = expected[i] as Row;
    if (!grouped) {
      expect(a, `${label} row ${i}`).toEqual(e);
      continue;
    }
    expect(Object.keys(a), `${label} row ${i} keys`).toEqual(Object.keys(e));
    for (const key of Object.keys(e)) {
      const exact = key === 'childCount' || typeof e[key] !== 'number';
      if (exact) expect(a[key], `${label} row ${i} ${key}`).toEqual(e[key]);
      else expect(approx(a[key], e[key]), `${label} row ${i} ${key}: ${String(a[key])} vs ${String(e[key])}`).toBe(true);
    }
  }
}

function buildProbes(engine: QueryEngine, rng: Rng, orders: readonly Order[], count: number): Probe[] {
  const probes: Probe[] = [];
  const bases: { traderId: string; req: SsrmRequest }[] = [
    { traderId: 'ALL', req: { startRow: 0, endRow: BIG, rowGroupCols: [], valueCols: [], groupKeys: [], sortModel: [], filterModel: null } },
    { traderId: 'T1', req: { startRow: 0, endRow: BIG, rowGroupCols: [], valueCols: [], groupKeys: [], sortModel: [{ colId: 'clientOrderId', sort: 'asc' }], filterModel: null } },
    { traderId: 'ALL', req: { startRow: 0, endRow: BIG, rowGroupCols: [], valueCols: [], groupKeys: [], sortModel: [{ colId: 'strategyParams', sort: 'desc' }, { colId: 'venue', sort: 'asc' }], filterModel: null } },
    {
      traderId: 'ALL',
      req: {
        startRow: 0, endRow: BIG,
        rowGroupCols: [{ id: 'venue', field: 'venue' }, { id: 'status', field: 'status' }],
        valueCols: [
          { id: 'notionalUsd', field: 'notionalUsd', aggFunc: 'sum' },
          { id: 'slippageBps', field: 'slippageBps', aggFunc: 'wavg' },
          { id: 'filledQty', field: 'filledQty', aggFunc: 'avg' },
          { id: 'orderId', field: 'orderId', aggFunc: 'count' },
        ],
        groupKeys: [], sortModel: [{ colId: 'notionalUsd', sort: 'desc' }], filterModel: null,
      },
    },
    {
      traderId: 'T2',
      req: {
        startRow: 0, endRow: BIG,
        rowGroupCols: [{ id: 'valueDate', field: 'valueDate' }],
        valueCols: [{ id: 'unrealisedPnlUsd', field: 'unrealisedPnlUsd', aggFunc: 'sum' }, { id: 'slippageBps', field: 'slippageBps', aggFunc: 'wavg' }],
        groupKeys: [], sortModel: [{ colId: 'slippageBps', sort: 'asc' }], filterModel: { status: { filterType: 'set', values: ['LIVE', 'PAUSED', 'FILLED'] } },
      },
    },
  ];
  for (const b of bases) probes.push({ ...b, label: `fixed ${probes.length}` });
  while (probes.length < count) {
    const { traderId, req } = randomRequest(rng, orders);
    probes.push({ traderId, req: { ...req, startRow: 0, endRow: BIG }, label: `random ${probes.length}` });
  }
  // Materialise root and a few deeper routes of every grouped view, so group states and leaves exist to patch.
  const out: Probe[] = [];
  for (const p of probes) {
    out.push(p);
    const depth = p.req.rowGroupCols.length;
    for (let tries = 0; tries < 3 && depth > 0; tries++) {
      const keys: string[] = [];
      for (let d = 0; d < depth; d++) {
        const level = engine.getRows(p.traderId, { ...p.req, groupKeys: keys });
        if (!level.ok || level.value.rows.length === 0) break;
        const field = (p.req.rowGroupCols[d] as { field?: string; id: string }).field ?? '';
        keys.push(String((pick(rng, level.value.rows) as Row)[field]));
        out.push({ ...p, req: { ...p.req, groupKeys: [...keys] }, label: `${p.label} ${keys.join('/')}` });
      }
    }
  }
  return out;
}

type Plan = {
  /** Flush budget for a tick (default unlimited). A budget of 0 defers every view, so its changes are carried over. */
  budget?: (tick: number) => number;
  /** Ticks after which every view is compared with a fresh build (default every tick). */
  compareAt?: (tick: number) => boolean;
  /** Run deferred rebuilds after each tick, as the runtime does between flushes. */
  drainRebuilds?: boolean;
  /** Which views a client tracks (default all). Untracked views go stale and are rebuilt on their next request. */
  subscribe?: 'all' | 'half' | 'none';
};

type Counts = { rebuilt: number; patched: number; inconsistencies: number; deferred: number; pending: number; stale: number; rebuilds: number };

function runProperty(seed: number, ticks: number, engineOptions: Partial<EngineOptions> = {}, plan: Plan = {}): Counts {
  const orders = propertyOrders(seed, ROWS);
  const store = storeFrom(orders, ROWS + 8);
  const engine = new QueryEngine(store, opts(engineOptions));
  const rng = mulberry32(seed * 7919);
  const world: World = { store, rng, nextId: 80_000_000, newWords: 0, ids: [] };
  const probes = buildProbes(engine, rng, orders, 26);
  const subscribe = plan.subscribe ?? 'all';
  [...engine.views()].forEach((v, i) => {
    if (subscribe === 'all' || (subscribe === 'half' && i % 2 === 0)) v.refs++;
  });
  const counts: Counts = { rebuilt: 0, patched: 0, inconsistencies: 0, deferred: 0, pending: 0, stale: 0, rebuilds: 0 };
  let clock = 1_000_000;

  for (let t = 0; t < ticks; t++) {
    const cs = randomTick(world);
    for (const c of engine.applyChanges(cs, plan.budget?.(t) ?? Infinity)) {
      if (c.rebuilt) counts.rebuilt++;
      else counts.patched++;
    }
    const last = engine.stats().lastApply;
    counts.deferred += last.deferred;
    counts.pending += last.pendingRebuild;
    counts.stale += last.unsubscribed;
    if (plan.drainRebuilds === true) {
      for (;;) {
        clock += 5_000;
        const view = engine.takeRebuild(clock);
        if (view === null) break;
        engine.rebuildView(view, clock);
        counts.rebuilds++;
      }
    }
    if (t % 11 === 5) {
      for (const field of store.staleRankFields()) for (const _ of store.refreshStringRanks(field, 200)) void _;
    }
    if (plan.compareAt?.(t) === false) continue;
    // After the tick (and any deferred work), every cached view must equal a fresh build.
    const fresh = new QueryEngine(store, opts());
    for (const probe of probes) {
      const label = `seed ${seed} tick ${t} ${probe.label} ${JSON.stringify({ trader: probe.traderId, g: probe.req.rowGroupCols.map((c) => c.id), k: probe.req.groupKeys, s: probe.req.sortModel, f: probe.req.filterModel })}`;
      const expected = fresh.getRows(probe.traderId, probe.req);
      const actual = engine.getRows(probe.traderId, probe.req);
      if (!expected.ok || !actual.ok) throw new Error(`${label}: ${expected.ok ? '' : expected.code} ${actual.ok ? '' : actual.code}`);
      expect(actual.value.rowCount, label).toBe(expected.value.rowCount);
      expectSameRows(actual.value.rows, expected.value.rows, probe.req.rowGroupCols.length > probe.req.groupKeys.length, label);
    }
  }
  for (const v of engine.views()) counts.inconsistencies += v.rebuiltAfterInconsistency;
  return counts;
}

describe('incremental view maintenance equals a full rebuild (property)', () => {
  for (const seed of [1, 2, 3, 4]) {
    it(`seed ${seed}: patched views match fresh builds after every tick, with no fallback rebuilds`, () => {
      const result = runProperty(seed, 45);
      expect(result.inconsistencies).toBe(0);
      expect(result.rebuilt).toBe(0);
      expect(result.patched).toBeGreaterThan(0);
    }, 180_000);
  }

  it('also matches when ticks are large enough to take the rebuild path', () => {
    const result = runProperty(5, 25, { structuralRebuildThreshold: 4 });
    expect(result.inconsistencies).toBe(0);
    expect(result.rebuilt).toBeGreaterThan(0);
    expect(result.patched).toBeGreaterThan(0);
  }, 180_000);

  it('carried-over changes: views skipped for lack of flush budget catch up exactly when they are next patched', () => {
    // Two ticks in three have no budget at all, so every view carries the changes of up to two ticks.
    const result = runProperty(6, 36, {}, { budget: (t) => (t % 3 === 2 ? Infinity : 0), compareAt: (t) => t % 3 === 2 });
    expect(result.deferred).toBeGreaterThan(100);
    expect(result.inconsistencies).toBe(0);
    expect(result.rebuilt).toBe(0);
  }, 180_000);

  it('a partial budget defers some views and patches the rest, and the result is still exact once everything has run', () => {
    const result = runProperty(7, 30, {}, { budget: (t) => (t % 4 === 3 ? Infinity : 0.02), compareAt: (t) => t % 4 === 3 });
    expect(result.deferred).toBeGreaterThan(0);
    expect(result.patched).toBeGreaterThan(0);
    expect(result.inconsistencies).toBe(0);
  }, 180_000);

  it('deferred rebuilds: a view over the structural threshold waits, is rebuilt between ticks, and equals a fresh build', () => {
    const result = runProperty(8, 25, { structuralRebuildThreshold: 4, deferRebuilds: true }, { drainRebuilds: true });
    expect(result.pending).toBeGreaterThan(0);
    expect(result.rebuilds).toBeGreaterThan(0);
    expect(result.rebuilt).toBe(0);
    expect(result.inconsistencies).toBe(0);
  }, 180_000);

  it('carry and deferred rebuild together', () => {
    const result = runProperty(9, 30, { structuralRebuildThreshold: 3, deferRebuilds: true }, { budget: (t) => (t % 3 === 2 ? Infinity : 0), compareAt: (t) => t % 3 === 2, drainRebuilds: true });
    expect(result.deferred).toBeGreaterThan(0);
    expect(result.rebuilds).toBeGreaterThan(0);
    expect(result.inconsistencies).toBe(0);
  }, 180_000);

  it('views nobody tracks are not patched, and are rebuilt correctly on their next request', () => {
    const none = runProperty(10, 20, { patchUnsubscribed: false }, { subscribe: 'none' });
    expect(none.patched).toBe(0);
    expect(none.stale).toBeGreaterThan(0);
    const half = runProperty(11, 20, { patchUnsubscribed: false }, { subscribe: 'half' });
    expect(half.patched).toBeGreaterThan(0);
    expect(half.stale).toBeGreaterThan(0);
    expect(half.inconsistencies).toBe(0);
  }, 180_000);
});
