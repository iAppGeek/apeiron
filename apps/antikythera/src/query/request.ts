import {
  COLUMN_BY_FIELD,
  parseFilterModel,
  type ColumnFilter,
  type ColumnMeta,
  type FilterModel,
  type OrderField,
  type SsrmRequest,
} from '@apeiron/logos';
import { fail, ok, type Result } from './errors.js';

export type AggName = 'sum' | 'avg' | 'count' | 'wavg';
export const AGG_NAMES: readonly AggName[] = ['sum', 'avg', 'count', 'wavg'];

/** The id AG Grid gives the auto group column; sorting by it sorts group rows by key. */
export const AUTO_GROUP_COL_ID = 'ag-Grid-AutoColumn';

export type SortEntry = {
  colId: string;
  /** Null for the auto group column. */
  field: OrderField | null;
  desc: boolean;
};

export type ValueCol = { id: string; field: OrderField; agg: AggName };

export type NormalizedQuery = {
  /** `'ALL'` or a trader id; applied as an implicit filter. */
  traderId: string;
  filter: FilterModel;
  sort: SortEntry[];
  groupCols: OrderField[];
  valueCols: ValueCol[];
  groupKeys: string[];
  startRow: number;
  endRow: number;
  /** Identifies the view: trader, filter, sort, group columns and value columns, key order normalised. */
  viewKey: string;
};

export type RequestLimits = { maxBlockRows: number };

const isNumericColumn = (meta: ColumnMeta): boolean => meta.type === 'number';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== null && v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

function canonicalFilter(model: FilterModel): FilterModel {
  const out: Record<string, ColumnFilter> = {};
  for (const colId of Object.keys(model).sort()) {
    const f = model[colId] as ColumnFilter;
    if (f.filterType === 'set') {
      out[colId] = { filterType: 'set', values: [...new Set(f.values)].sort() };
    } else if ('conditions' in f) {
      const conditions = f.conditions
        .map((c) => canonicalize(c) as typeof c)
        .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
      out[colId] = { filterType: f.filterType, operator: f.operator, conditions };
    } else {
      out[colId] = canonicalize(f) as ColumnFilter;
    }
  }
  return out;
}

function validateFilter(model: FilterModel): Result<FilterModel> {
  for (const [colId, f] of Object.entries(model)) {
    const meta = COLUMN_BY_FIELD.get(colId as OrderField);
    if (meta === undefined) return fail('UNSUPPORTED_FILTER', `Filter on unknown column: ${colId}`);
    if (f.filterType !== meta.filter) {
      return fail('UNSUPPORTED_FILTER', `Column ${colId} takes a ${meta.filter} filter, got ${f.filterType}`);
    }
  }
  return ok(canonicalFilter(model));
}

function resolveAgg(meta: ColumnMeta, name: string | undefined): Result<AggName> {
  const resolved = name ?? (meta.aggFunc === 'wavg:notionalUsd' ? 'wavg' : meta.aggFunc);
  if (resolved === undefined || !(AGG_NAMES as readonly string[]).includes(resolved)) {
    return fail('UNSUPPORTED_AGG', `Unsupported aggregate: ${name ?? '(none)'}`);
  }
  const agg = resolved as AggName;
  if (agg !== 'count' && !isNumericColumn(meta)) {
    return fail('UNSUPPORTED_AGG', `${agg} needs a numeric column, ${meta.field} is ${meta.type}`);
  }
  return ok(agg);
}

/**
 * Validates an SSRM request and reduces it to the canonical form the engine works with. Pure: depends
 * only on the column metadata.
 */
export function normalizeRequest(
  traderId: string,
  req: SsrmRequest,
  limits: RequestLimits,
): Result<NormalizedQuery> {
  if (req.pivotMode === true) return fail('UNSUPPORTED_PIVOT', 'Pivot mode is not supported');
  if (req.endRow < req.startRow) return fail('BAD_REQUEST', 'endRow must not be before startRow');
  if (req.endRow - req.startRow > limits.maxBlockRows) {
    return fail('BAD_REQUEST', `Block larger than ${limits.maxBlockRows} rows`);
  }

  const parsedFilter = parseFilterModel(req.filterModel);
  if (!parsedFilter.ok) return fail('UNSUPPORTED_FILTER', parsedFilter.error);
  const filter = validateFilter(parsedFilter.value);
  if (!filter.ok) return filter;

  const groupCols: OrderField[] = [];
  for (const g of req.rowGroupCols) {
    const field = (g.field ?? g.id) as OrderField;
    const meta = COLUMN_BY_FIELD.get(field);
    if (meta === undefined) return fail('UNKNOWN_COLUMN', `Unknown group column: ${field}`);
    if (!meta.groupable) return fail('UNSUPPORTED_GROUP', `Column ${field} is not groupable`);
    if (groupCols.includes(field)) return fail('BAD_REQUEST', `Duplicate group column: ${field}`);
    groupCols.push(field);
  }
  if (req.groupKeys.length > groupCols.length) {
    return fail('BAD_REQUEST', 'More group keys than group columns');
  }

  const valueCols: ValueCol[] = [];
  for (const v of req.valueCols) {
    const field = (v.field ?? v.id) as OrderField;
    const meta = COLUMN_BY_FIELD.get(field);
    if (meta === undefined) return fail('UNKNOWN_COLUMN', `Unknown value column: ${field}`);
    const agg = resolveAgg(meta, v.aggFunc);
    if (!agg.ok) return agg;
    const existing = valueCols.find((c) => c.field === field);
    if (existing !== undefined) {
      if (existing.agg === agg.value) continue;
      return fail('BAD_REQUEST', `Column ${field} has two different aggregates`);
    }
    valueCols.push({ id: v.id, field, agg: agg.value });
  }

  valueCols.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const grouped = groupCols.length > 0;
  const sort: SortEntry[] = [];
  for (const s of req.sortModel) {
    if (sort.some((e) => e.colId === s.colId)) continue;
    if (s.colId === AUTO_GROUP_COL_ID) {
      if (grouped) sort.push({ colId: s.colId, field: null, desc: s.sort === 'desc' });
      continue;
    }
    if (!COLUMN_BY_FIELD.has(s.colId as OrderField)) return fail('UNKNOWN_COLUMN', `Unknown sort column: ${s.colId}`);
    sort.push({ colId: s.colId, field: s.colId as OrderField, desc: s.sort === 'desc' });
  }
  if (!grouped && sort.length === 0) sort.push({ colId: 'createdAt', field: 'createdAt', desc: true });

  // Flat views never aggregate, so their key ignores value columns and shares across clients.
  const keyedValueCols = grouped ? valueCols : [];
  const viewKey = JSON.stringify([
    traderId,
    filter.value,
    sort.map((s) => [s.colId, s.desc]),
    groupCols,
    keyedValueCols.map((v) => [v.id, v.field, v.agg]),
  ]);

  return ok({
    traderId,
    filter: filter.value,
    sort,
    groupCols,
    valueCols,
    groupKeys: req.groupKeys,
    startRow: req.startRow,
    endRow: req.endRow,
    viewKey,
  });
}
