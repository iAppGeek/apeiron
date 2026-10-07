import {
  ALGO_TYPES,
  CURRENCY_PAIRS,
  ORDER_STATUSES,
  SIDES,
  VENUES,
  mulberry32,
  type CodecName,
  type Rng,
  type Row,
  type SsrmRequest,
} from '@apeiron/logos';
import type { CodecChoice } from './args.js';

/** Rows per block: the grid's `cacheBlockSize`. */
export const BLOCK_SIZE = 100;
const DAY_MS = 86_400_000;

export const TRADER_CHOICES = ['ALL', 'T1', 'T2', 'T3', 'T4', 'T5'] as const;

type GroupCol = { id: string; field: string };
type ValueCol = { id: string; field: string; aggFunc: string };

/** What a trader has set up in the grid: the parts of an SSRM request that stay the same while scrolling. */
export type ViewSpec = {
  rowGroupCols: GroupCol[];
  valueCols: ValueCol[];
  sortModel: SsrmRequest['sortModel'];
  filterModel: Record<string, unknown> | null;
};

export type ClientRole = 'normal' | 'slow' | 'switcher';

export type ClientPlan = {
  index: number;
  clientId: string;
  traderId: string;
  codec: CodecName;
  role: ClientRole;
  /** The one client that switches hermes to the stress preset and back. */
  controller: boolean;
  seed: number;
  view: ViewSpec;
};

const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T;
const chance = (rng: Rng, p: number): boolean => rng() < p;

/** An independent stream for one client: the same seed and index always give the same sequence. */
export function clientRng(seed: number, index: number): Rng {
  return mulberry32(Math.imul(seed + 1, 0x9e3779b1) ^ Math.imul(index + 1, 0x85ebca6b));
}

const GROUP_FIELDS = ['currencyPair', 'status', 'algoType', 'venue', 'side', 'tenor', 'urgency', 'timeInForce', 'orderType', 'traderName'] as const;
const AGG_COLS: readonly ValueCol[] = [
  { id: 'notionalUsd', field: 'notionalUsd', aggFunc: 'sum' },
  { id: 'filledNotionalUsd', field: 'filledNotionalUsd', aggFunc: 'sum' },
  { id: 'unrealisedPnlUsd', field: 'unrealisedPnlUsd', aggFunc: 'sum' },
  { id: 'slippageBps', field: 'slippageBps', aggFunc: 'wavg' },
  { id: 'pctComplete', field: 'pctComplete', aggFunc: 'wavg' },
  { id: 'numFills', field: 'numFills', aggFunc: 'sum' },
  { id: 'orderQty', field: 'orderQty', aggFunc: 'sum' },
];
const FLAT_SORTS = [
  'createdAt',
  'notionalUsd',
  'unrealisedPnlUsd',
  'slippageBps',
  'orderQty',
  'filledQty',
  'distanceToLimitBps',
  'lastUpdateTime',
  'clientOrderId',
  'currencyPair',
  'status',
  'traderName',
  'marketMid',
] as const;

const fmtDate = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

function subset<T>(rng: Rng, items: readonly T[], max: number): T[] {
  const chosen = new Set<T>();
  const count = 1 + Math.floor(rng() * max);
  while (chosen.size < Math.min(count, items.length)) chosen.add(pick(rng, items));
  return [...chosen];
}

/** One filter in the shape AG Grid sends. Number and date thresholds are drawn from a continuous range, so most filters make a view nobody has built yet. */
function randomFilter(rng: Rng, nowMs: number): [string, unknown] {
  const kind = pick(rng, ['set', 'set', 'number', 'date', 'text'] as const);
  if (kind === 'set') {
    const [field, values] = pick(rng, [
      ['status', ORDER_STATUSES],
      ['currencyPair', CURRENCY_PAIRS],
      ['algoType', ALGO_TYPES],
      ['venue', VENUES],
      ['side', SIDES],
    ] as const);
    return [field, { filterType: 'set', values: subset<string>(rng, values, 3) }];
  }
  if (kind === 'number') {
    const field = pick(rng, ['notionalUsd', 'orderQty', 'filledQty'] as const);
    const lo = Math.round(1e5 + rng() * 2e7);
    if (chance(rng, 0.5)) return [field, { filterType: 'number', type: 'greaterThan', filter: lo }];
    return [field, { filterType: 'number', type: 'inRange', filter: lo, filterTo: lo + Math.round(rng() * 4e7) }];
  }
  if (kind === 'date') {
    const field = pick(rng, ['createdAt', 'startTime', 'lastUpdateTime'] as const);
    const from = nowMs - Math.floor(rng() * 180 * DAY_MS);
    if (chance(rng, 0.5)) return [field, { filterType: 'date', type: 'greaterThan', dateFrom: fmtDate(from), dateTo: null }];
    return [field, { filterType: 'date', type: 'inRange', dateFrom: fmtDate(from), dateTo: fmtDate(from + Math.floor(rng() * 30 * DAY_MS)) }];
  }
  const piece = String(Math.floor(rng() * 10 ** 3)).padStart(3, '0');
  return ['clientOrderId', { filterType: 'text', type: 'contains', filter: piece }];
}

function randomFilterModel(rng: Rng, nowMs: number): Record<string, unknown> | null {
  if (chance(rng, 0.5)) return null;
  const model: Record<string, unknown> = {};
  const count = chance(rng, 0.7) ? 1 : 2;
  for (let i = 0; i < count; i++) {
    const [field, filter] = randomFilter(rng, nowMs);
    model[field] = filter;
  }
  return model;
}

function randomGrouping(rng: Rng): { rowGroupCols: GroupCol[]; valueCols: ValueCol[] } {
  const depth = chance(rng, 0.7) ? 1 : 2;
  const fields = subset<string>(rng, GROUP_FIELDS, 1);
  while (fields.length < depth) {
    const f = pick(rng, GROUP_FIELDS);
    if (!fields.includes(f)) fields.push(f);
  }
  const valueCols = subset(rng, AGG_COLS, 3);
  return { rowGroupCols: fields.slice(0, depth).map((f): GroupCol => ({ id: f, field: f })), valueCols };
}

function randomSort(rng: Rng, grouping: { rowGroupCols: GroupCol[]; valueCols: ValueCol[] }): SsrmRequest['sortModel'] {
  const sort = chance(rng, 0.5) ? 'asc' : 'desc';
  if (grouping.rowGroupCols.length > 0) {
    if (chance(rng, 0.3)) return [];
    if (chance(rng, 0.4)) return [{ colId: 'ag-Grid-AutoColumn', sort }];
    return [{ colId: (pick(rng, grouping.valueCols.length > 0 ? grouping.valueCols : AGG_COLS) as ValueCol).id, sort }];
  }
  if (chance(rng, 0.25)) return [];
  const first = pick(rng, FLAT_SORTS);
  if (!chance(rng, 0.2)) return [{ colId: first, sort }];
  const second = pick(rng, FLAT_SORTS);
  return second === first ? [{ colId: first, sort }] : [{ colId: first, sort }, { colId: second, sort: sort === 'asc' ? 'desc' : 'asc' }];
}

/** A realistic starting view: 40% grouped, a sort, and about half have a filter. */
export function randomView(rng: Rng, nowMs: number): ViewSpec {
  const grouping = chance(rng, 0.4) ? randomGrouping(rng) : { rowGroupCols: [], valueCols: [] };
  return { ...grouping, sortModel: randomSort(rng, grouping), filterModel: randomFilterModel(rng, nowMs) };
}

/** What a trader does to the grid next: change the sort, the filter or the grouping. The result differs from `view`. */
export function changeView(rng: Rng, view: ViewSpec, nowMs: number): ViewSpec {
  const before = JSON.stringify(view);
  for (let attempt = 0; attempt < 8; attempt++) {
    const roll = rng();
    let next: ViewSpec;
    if (roll < 0.35) {
      next = { ...view, sortModel: randomSort(rng, view) };
    } else if (roll < 0.7) {
      const [field, filter] = randomFilter(rng, nowMs);
      next = { ...view, filterModel: chance(rng, 0.3) ? null : { [field]: filter } };
    } else {
      const grouping = view.rowGroupCols.length > 0 && chance(rng, 0.4) ? { rowGroupCols: [], valueCols: [] } : randomGrouping(rng);
      next = { ...view, ...grouping, sortModel: randomSort(rng, grouping) };
    }
    if (JSON.stringify(next) !== before) return next;
  }
  return { ...view, sortModel: [{ colId: pick(rng, FLAT_SORTS), sort: chance(rng, 0.5) ? 'asc' : 'desc' }], rowGroupCols: [], valueCols: [] };
}

/** An SSRM request for one block of one route, in the shape AG Grid sends. */
export function requestFor(view: ViewSpec, startRow: number, groupKeys: readonly string[] = [], blockRows = BLOCK_SIZE): SsrmRequest {
  return {
    startRow,
    endRow: startRow + blockRows,
    rowGroupCols: view.rowGroupCols.map((c) => ({ id: c.id, field: c.field })),
    valueCols: view.valueCols.map((c) => ({ id: c.id, field: c.field, aggFunc: c.aggFunc })),
    groupKeys: [...groupKeys],
    sortModel: view.sortModel.map((s) => ({ colId: s.colId, sort: s.sort })),
    filterModel: view.filterModel,
  };
}

export const routeKey = (route: readonly string[]): string => route.join('\u0000');

/** What a client has learnt about its current view from the responses so far: row counts per route and the group keys it can drill into. */
export class ViewKnowledge {
  private readonly counts = new Map<string, number>();
  private readonly keys = new Map<string, string[]>();

  constructor(private readonly view: ViewSpec) {}

  learn(route: readonly string[], rows: readonly Row[], rowCount: number): void {
    const key = routeKey(route);
    this.counts.set(key, rowCount);
    const col = this.view.rowGroupCols[route.length];
    if (col === undefined) return;
    const known = new Set(this.keys.get(key));
    for (const row of rows) {
      const value = row[col.field];
      if (value !== undefined && value !== null) known.add(String(value));
    }
    this.keys.set(key, [...known]);
  }

  rowCount(route: readonly string[]): number | undefined {
    return this.counts.get(routeKey(route));
  }

  groupKeysAt(route: readonly string[]): readonly string[] {
    return this.keys.get(routeKey(route)) ?? [];
  }
}

export type ScrollTarget = { groupKeys: string[]; startRow: number };

/**
 * Where a scrolling trader looks next: a quarter of the time the top block (the newest orders), otherwise a
 * random block of the level. In a grouped view half the requests drill into a group, with a group key the client
 * has really been sent.
 */
export function pickScrollTarget(rng: Rng, view: ViewSpec, knowledge: ViewKnowledge): ScrollTarget {
  const route: string[] = [];
  if (view.rowGroupCols.length > 0) {
    while (route.length < view.rowGroupCols.length && chance(rng, 0.5)) {
      const keys = knowledge.groupKeysAt(route);
      if (keys.length === 0) break;
      route.push(pick(rng, keys));
    }
  }
  const rowCount = knowledge.rowCount(route);
  const blocks = rowCount === undefined ? 1 : Math.max(1, Math.ceil(rowCount / BLOCK_SIZE));
  const block = chance(rng, 0.25) ? 0 : Math.floor(rng() * blocks);
  return { groupKeys: route, startRow: block * BLOCK_SIZE };
}

/**
 * Who the clients are. Role, trader and starting view are fixed by the seed; client 0 also controls the stress
 * window, client 1 is the slow consumer and client 2 the codec switcher (when there are at least four clients).
 */
export function planClients(options: { clients: number; codec: CodecChoice; seed: number; special: boolean; nowMs: number }): ClientPlan[] {
  const plans: ClientPlan[] = [];
  for (let index = 0; index < options.clients; index++) {
    const rng = clientRng(options.seed, index);
    const roles: ClientRole = !options.special || options.clients < 4 ? 'normal' : index === 1 ? 'slow' : index === 2 ? 'switcher' : 'normal';
    const codec: CodecName = options.codec === 'both' ? (index % 2 === 0 ? 'json' : 'msgpack') : options.codec;
    plans.push({
      index,
      clientId: `talos-${options.seed}-${index}`,
      traderId: chance(rng, 0.3) ? 'ALL' : (pick(rng, TRADER_CHOICES.slice(1)) as string),
      codec,
      role: roles,
      controller: options.special && index === 0,
      seed: options.seed,
      view: randomView(rng, options.nowMs),
    });
  }
  return plans;
}
