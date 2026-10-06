import {
  COLUMN_BY_FIELD,
  parseFilterDate,
  type ColumnFilter,
  type DateFilter,
  type FilterModel,
  type NumberFilter,
  type OrderField,
  type SimpleFilter,
  type TextFilter,
} from '@apeiron/logos';
import type { ColumnarStore, EnumColumn } from '../store/columnar-store.js';

export type Predicate = (row: number) => boolean;

export const TRADER_ALL = 'ALL';
const DAY_MS = 86_400_000;

const never: Predicate = () => false;

type NumericOp = {
  type: NumberFilter['type'];
  a: number;
  b: number;
};

function numericPredicate(data: Float64Array, op: NumericOp): Predicate {
  const { a, b } = op;
  switch (op.type) {
    case 'equals':
      return (i) => data[i] === a;
    case 'notEqual':
      return (i) => {
        const v = data[i] as number;
        return v === v && v !== a;
      };
    case 'lessThan':
      return (i) => (data[i] as number) < a;
    case 'lessThanOrEqual':
      return (i) => (data[i] as number) <= a;
    case 'greaterThan':
      return (i) => (data[i] as number) > a;
    case 'greaterThanOrEqual':
      return (i) => (data[i] as number) >= a;
    case 'inRange':
      return (i) => {
        const v = data[i] as number;
        return v >= a && v <= b;
      };
    case 'blank':
      return (i) => {
        const v = data[i] as number;
        return v !== v;
      };
    case 'notBlank':
      return (i) => {
        const v = data[i] as number;
        return v === v;
      };
  }
}

function numberCondition(data: Float64Array, f: NumberFilter): Predicate {
  return numericPredicate(data, { type: f.type, a: f.filter ?? Number.NaN, b: f.filterTo ?? Number.NaN });
}

/**
 * Date filters are UTC-day granular (Appendix B). With `D0 = dayStart(dateFrom)` and `D1 = dayStart(dateTo)`:
 * equals `[D0, D0+1d)`, lessThan `< D0`, lessThanOrEqual `< D0+1d`, greaterThan `>= D0+1d`,
 * greaterThanOrEqual `>= D0`, inRange `[D0, D1+1d)`. Null only matches blank.
 */
function dateCondition(data: Float64Array, f: DateFilter): Predicate {
  const from = typeof f.dateFrom === 'string' ? parseFilterDate(f.dateFrom) : Number.NaN;
  const to = typeof f.dateTo === 'string' ? parseFilterDate(f.dateTo) : Number.NaN;
  const d0 = Math.floor(from / DAY_MS) * DAY_MS;
  const d1 = Math.floor(to / DAY_MS) * DAY_MS;
  switch (f.type) {
    case 'equals':
      return (i) => {
        const v = data[i] as number;
        return v >= d0 && v < d0 + DAY_MS;
      };
    case 'notEqual':
      return (i) => {
        const v = data[i] as number;
        return v === v && (v < d0 || v >= d0 + DAY_MS);
      };
    case 'lessThan':
      return (i) => (data[i] as number) < d0;
    case 'lessThanOrEqual':
      return (i) => (data[i] as number) < d0 + DAY_MS;
    case 'greaterThan':
      return (i) => (data[i] as number) >= d0 + DAY_MS;
    case 'greaterThanOrEqual':
      return (i) => (data[i] as number) >= d0;
    case 'inRange':
      return (i) => {
        const v = data[i] as number;
        return v >= d0 && v < d1 + DAY_MS;
      };
    case 'blank':
      return (i) => {
        const v = data[i] as number;
        return v !== v;
      };
    case 'notBlank':
      return (i) => {
        const v = data[i] as number;
        return v === v;
      };
  }
}

function textCondition(data: string[], f: TextFilter): Predicate {
  const needle = (f.filter ?? '').toLowerCase();
  switch (f.type) {
    case 'contains':
      return (i) => (data[i] as string).toLowerCase().includes(needle);
    case 'notContains':
      return (i) => !(data[i] as string).toLowerCase().includes(needle);
    case 'equals':
      return (i) => (data[i] as string).toLowerCase() === needle;
    case 'notEqual':
      return (i) => (data[i] as string).toLowerCase() !== needle;
    case 'startsWith':
      return (i) => (data[i] as string).toLowerCase().startsWith(needle);
    case 'endsWith':
      return (i) => (data[i] as string).toLowerCase().endsWith(needle);
    case 'blank':
      return (i) => (data[i] as string) === '';
    case 'notBlank':
      return (i) => (data[i] as string) !== '';
  }
}

/** Set filters compare dictionary codes through a precomputed allowed-code lookup table. */
function setCondition(col: EnumColumn, values: readonly string[]): Predicate {
  const allowed = new Uint8Array(col.dict.size);
  let any = false;
  for (const v of values) {
    const code = col.dict.codeOf(v);
    if (code !== undefined) {
      allowed[code] = 1;
      any = true;
    }
  }
  if (!any) return never;
  const codes = col.codes;
  return (i) => allowed[codes[i] as number] === 1;
}

function simpleCondition(store: ColumnarStore, field: OrderField, f: SimpleFilter): Predicate {
  switch (f.filterType) {
    case 'text':
      return textCondition(store.stringColumn(field), f);
    case 'number':
      return numberCondition(store.numberColumn(field), f);
    case 'date':
      return dateCondition(store.numberColumn(field), f);
  }
}

function columnPredicate(store: ColumnarStore, field: OrderField, f: ColumnFilter): Predicate {
  if (f.filterType === 'set') return setCondition(store.enumColumn(field), f.values);
  if ('conditions' in f) {
    const preds = f.conditions.map((c) => simpleCondition(store, field, c));
    if (f.operator === 'AND') return (i) => preds.every((p) => p(i));
    return (i) => preds.some((p) => p(i));
  }
  return simpleCondition(store, field, f);
}

/** Cheap, selective predicates first. */
const costRank = (f: ColumnFilter): number => {
  if (f.filterType === 'set') return 0;
  if (f.filterType === 'number' || f.filterType === 'date') return 1;
  return 2;
};

/**
 * Compiles the (already validated) filter model plus the implicit trader scope into predicates over
 * row indexes. A row passes when every predicate passes. Unknown traders match nothing.
 */
export function compileFilter(store: ColumnarStore, model: FilterModel, traderId: string): Predicate[] {
  const preds: Predicate[] = [];
  if (traderId !== TRADER_ALL) {
    const col = store.enumColumn('traderId');
    const code = col.dict.codeOf(traderId);
    if (code === undefined) return [never];
    const codes = col.codes;
    preds.push((i) => codes[i] === code);
  }
  const entries = Object.entries(model)
    .filter(([colId]) => COLUMN_BY_FIELD.has(colId as OrderField))
    .sort(([, a], [, b]) => costRank(a) - costRank(b));
  for (const [colId, f] of entries) preds.push(columnPredicate(store, colId as OrderField, f));
  return preds;
}

/** Row indexes (ascending) of the rows `[0, n)` that pass every predicate. */
export function filterRows(n: number, preds: readonly Predicate[]): Uint32Array {
  const out = new Uint32Array(n);
  let k = 0;
  if (preds.length === 0) {
    for (let i = 0; i < n; i++) out[i] = i;
    return out;
  }
  if (preds.length === 1) {
    const p = preds[0] as Predicate;
    for (let i = 0; i < n; i++) if (p(i)) out[k++] = i;
  } else if (preds.length === 2) {
    const p = preds[0] as Predicate;
    const q = preds[1] as Predicate;
    for (let i = 0; i < n; i++) if (p(i) && q(i)) out[k++] = i;
  } else {
    outer: for (let i = 0; i < n; i++) {
      for (let j = 0; j < preds.length; j++) if (!(preds[j] as Predicate)(i)) continue outer;
      out[k++] = i;
    }
  }
  return out.slice(0, k);
}
