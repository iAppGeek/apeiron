import {
  COLUMNS,
  GROUPABLE_FIELDS,
  NUMBER_FILTER_TYPES,
  TEXT_FILTER_TYPES,
  type ColumnMeta,
  type Order,
  type OrderField,
  type Rng,
  type SsrmRequest,
} from '@apeiron/logos';

const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T;
const chance = (rng: Rng, p: number): boolean => rng() < p;

const fmtDate = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

function simpleFilter(rng: Rng, meta: ColumnMeta, orders: readonly Order[], kind: 'text' | 'number' | 'date'): unknown {
  const sample = (pick(rng, orders) as Order)[meta.field];
  if (kind === 'text') {
    const type = pick(rng, TEXT_FILTER_TYPES);
    const text = String(sample);
    const a = Math.floor(rng() * text.length);
    const piece = text.slice(a, a + 1 + Math.floor(rng() * 4));
    const filter = chance(rng, 0.5) ? piece : piece.toUpperCase();
    return type === 'blank' || type === 'notBlank' ? { filterType: 'text', type } : { filterType: 'text', type, filter };
  }
  const type = pick(rng, NUMBER_FILTER_TYPES);
  const base = typeof sample === 'number' ? sample : ((pick(rng, orders) as Order).orderQty as number);
  const other = (pick(rng, orders) as Order)[meta.field];
  const second = typeof other === 'number' ? other : base;
  const lo = Math.min(base, second);
  const hi = Math.max(base, second);
  if (type === 'blank' || type === 'notBlank') return { filterType: kind, type };
  if (kind === 'number') return { filterType: 'number', type, filter: lo, filterTo: hi };
  const jitter = chance(rng, 0.5) ? 0 : Math.floor(rng() * 86_400_000);
  return { filterType: 'date', type, dateFrom: fmtDate(lo + jitter), dateTo: fmtDate(hi + jitter) };
}

function columnFilter(rng: Rng, meta: ColumnMeta, orders: readonly Order[]): unknown {
  if (meta.filter === 'set') {
    const values = new Set<string>();
    const count = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < count; i++) values.add(String((pick(rng, orders) as Order)[meta.field]));
    if (chance(rng, 0.1)) values.add('NOT-A-VALUE');
    return { filterType: 'set', values: [...values] };
  }
  const kind = meta.filter;
  if (chance(rng, 0.3)) {
    return {
      filterType: kind,
      operator: chance(rng, 0.5) ? 'AND' : 'OR',
      conditions: [simpleFilter(rng, meta, orders, kind), simpleFilter(rng, meta, orders, kind)],
    };
  }
  return simpleFilter(rng, meta, orders, kind);
}

const NUMERIC_COLUMNS: readonly ColumnMeta[] = COLUMNS.filter((c) => c.type === 'number');

export type GeneratedRequest = { traderId: string; req: SsrmRequest };

/**
 * A random valid request (no group keys yet; the caller walks the reference groups to pick real
 * keys). Filter values are sampled from the data so filters are selective but rarely empty.
 */
export function randomRequest(rng: Rng, orders: readonly Order[]): GeneratedRequest {
  const traderId = chance(rng, 0.45) ? 'ALL' : chance(rng, 0.95) ? `T${1 + Math.floor(rng() * 5)}` : 'T9';

  const filterModel: Record<string, unknown> = {};
  const nFilters = chance(rng, 0.25) ? 0 : 1 + Math.floor(rng() * 3);
  for (let i = 0; i < nFilters; i++) {
    // Pick the filter kind first so rare kinds (text has 4 columns, date 7) are exercised as often as number.
    const kind = pick(rng, ['text', 'number', 'date', 'set'] as const);
    const meta = pick(rng, COLUMNS.filter((c) => c.filter === kind));
    filterModel[meta.field] = columnFilter(rng, meta, orders);
  }

  const groupCols: OrderField[] = [];
  if (chance(rng, 0.6)) {
    const depth = 1 + Math.floor(rng() * 3);
    while (groupCols.length < depth) {
      const f = pick(rng, GROUPABLE_FIELDS);
      if (!groupCols.includes(f)) groupCols.push(f);
    }
  }

  const valueCols: SsrmRequest['valueCols'] = [];
  const nValues = Math.floor(rng() * 5);
  for (let i = 0; i < nValues; i++) {
    const meta = pick(rng, NUMERIC_COLUMNS);
    if (valueCols.some((v) => v.id === meta.field)) continue;
    valueCols.push({ id: meta.field, field: meta.field, aggFunc: pick(rng, ['sum', 'avg', 'count', 'wavg']) });
  }
  if (chance(rng, 0.2)) {
    const meta = pick(rng, COLUMNS.filter((c) => c.type !== 'number'));
    if (!valueCols.some((v) => v.id === meta.field)) {
      valueCols.push({ id: meta.field, field: meta.field, aggFunc: 'count' });
    }
  }

  const sortModel: SsrmRequest['sortModel'] = [];
  const nSort = chance(rng, 0.3) ? 0 : 1 + Math.floor(rng() * 3);
  for (let i = 0; i < nSort; i++) {
    const roll = rng();
    let colId: string;
    if (groupCols.length > 0 && roll < 0.25) colId = 'ag-Grid-AutoColumn';
    else if (valueCols.length > 0 && roll < 0.6) colId = (pick(rng, valueCols) as { id: string }).id;
    else if (groupCols.length > 0 && roll < 0.7) colId = pick(rng, groupCols);
    else colId = (pick(rng, COLUMNS) as ColumnMeta).field;
    if (sortModel.some((s) => s.colId === colId)) continue;
    sortModel.push({ colId, sort: chance(rng, 0.5) ? 'asc' : 'desc' });
  }

  return {
    traderId,
    req: {
      startRow: 0,
      endRow: 100,
      rowGroupCols: groupCols.map((f) => ({ id: f, field: f })),
      valueCols,
      groupKeys: [],
      sortModel,
      filterModel: Object.keys(filterModel).length === 0 ? (chance(rng, 0.5) ? null : {}) : filterModel,
    },
  };
}
