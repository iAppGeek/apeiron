import {
  COLUMN_BY_FIELD,
  type ColumnFilter,
  type ColumnMeta,
  type Order,
  type OrderField,
  type Row,
  type SimpleFilter,
  type SsrmRequest,
} from '@apeiron/logos';

/**
 * Naive reference implementation of the Appendix B request semantics over plain `Order[]`, written
 * with Array.filter/sort/reduce and no shared code with the engine. Property tests compare the two.
 */

const DAY_MS = 86_400_000;

function dateMs(text: string): number {
  return Date.parse(`${text.replace(' ', 'T')}Z`);
}

function numericMatch(v: number | null, f: { type: string; a: number; b: number }): boolean {
  if (f.type === 'blank') return v === null;
  if (f.type === 'notBlank') return v !== null;
  if (v === null) return false;
  switch (f.type) {
    case 'equals':
      return v === f.a;
    case 'notEqual':
      return v !== f.a;
    case 'lessThan':
      return v < f.a;
    case 'lessThanOrEqual':
      return v <= f.a;
    case 'greaterThan':
      return v > f.a;
    case 'greaterThanOrEqual':
      return v >= f.a;
    case 'inRange':
      return v >= f.a && v <= f.b;
    default:
      throw new Error(`bad type ${f.type}`);
  }
}

function simpleMatch(value: unknown, f: SimpleFilter): boolean {
  if (f.filterType === 'text') {
    const s = String(value).toLowerCase();
    const n = (f.filter ?? '').toLowerCase();
    switch (f.type) {
      case 'contains':
        return s.indexOf(n) >= 0;
      case 'notContains':
        return s.indexOf(n) < 0;
      case 'equals':
        return s === n;
      case 'notEqual':
        return s !== n;
      case 'startsWith':
        return s.slice(0, n.length) === n;
      case 'endsWith':
        return n.length === 0 || s.slice(-n.length) === n;
      case 'blank':
        return s.length === 0;
      case 'notBlank':
        return s.length > 0;
    }
  }
  const v = value as number | null;
  if (f.filterType === 'number') {
    return numericMatch(v, { type: f.type, a: f.filter ?? NaN, b: f.filterTo ?? NaN });
  }
  if (f.type === 'blank') return v === null;
  if (f.type === 'notBlank') return v !== null;
  if (v === null) return false;
  const day = (ms: number): number => Math.floor(ms / DAY_MS);
  const d0 = day(f.dateFrom === null || f.dateFrom === undefined ? NaN : dateMs(f.dateFrom));
  const d1 = day(f.dateTo === null || f.dateTo === undefined ? NaN : dateMs(f.dateTo));
  const d = day(v);
  switch (f.type) {
    case 'equals':
      return d === d0;
    case 'notEqual':
      return d !== d0;
    case 'lessThan':
      return d < d0;
    case 'lessThanOrEqual':
      return d <= d0;
    case 'greaterThan':
      return d > d0;
    case 'greaterThanOrEqual':
      return d >= d0;
    default:
      return d >= d0 && d <= d1;
  }
}

function columnMatch(value: unknown, f: ColumnFilter): boolean {
  if (f.filterType === 'set') return f.values.includes(String(value));
  if ('conditions' in f) {
    const results = f.conditions.map((c) => simpleMatch(value, c));
    return f.operator === 'AND' ? results.every(Boolean) : results.some(Boolean);
  }
  return simpleMatch(value, f);
}

const cmpValues = (x: unknown, y: unknown): number => {
  if (x === y) return 0;
  if (x === null) return -1;
  if (y === null) return 1;
  return (x as number | string) < (y as number | string) ? -1 : 1;
};

function sortLeaves(orders: Order[], req: SsrmRequest): Order[] {
  const keys = req.sortModel
    .filter((s) => COLUMN_BY_FIELD.has(s.colId as OrderField))
    .map((s) => ({ field: s.colId as OrderField, dir: s.sort === 'desc' ? -1 : 1 }));
  const effective = keys.length > 0 ? keys : [{ field: 'createdAt' as OrderField, dir: -1 }];
  const tie = effective[effective.length - 1]?.dir ?? 1;
  return [...orders].sort((a, b) => {
    for (const k of effective) {
      const r = cmpValues(a[k.field], b[k.field]);
      if (r !== 0) return r * k.dir;
    }
    return cmpValues(a.orderId, b.orderId) * tie;
  });
}

function groupKeyOf(order: Order, field: OrderField, meta: ColumnMeta): string {
  const v = order[field];
  if (v === null) return '(blank)';
  if (meta.type === 'date') return new Date(v as number).toISOString().slice(0, 10);
  return String(v);
}

type RefAgg = { id: string; field: OrderField; agg: string };

function aggregateOf(rows: Order[], a: RefAgg): number | null {
  if (a.agg === 'count') return rows.length;
  const present = rows.filter((r) => r[a.field] !== null);
  if (present.length === 0) return null;
  const sum = present.reduce((acc, r) => acc + (r[a.field] as number), 0);
  switch (a.agg) {
    case 'sum':
      return sum;
    case 'avg':
      return sum / present.length;
    default: {
      const wx = present.reduce((acc, r) => acc + r.notionalUsd * (r[a.field] as number), 0);
      const w = present.reduce((acc, r) => acc + r.notionalUsd, 0);
      return w > 0 ? wx / w : null;
    }
  }
}

export type RefResult = { rows: Row[]; rowCount: number };

/** Replaces -0 with 0 so rows compare equal to the engine's, which stores -0 as 0. */
export function zeroNormalised(row: Row): Row {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v === 0 ? 0 : v]));
}

export function referenceGetRows(all: readonly Order[], traderId: string, req: SsrmRequest): RefResult {
  let rows = all.filter((o) => traderId === 'ALL' || o.traderId === traderId);
  const model = (req.filterModel ?? {}) as Record<string, ColumnFilter>;
  for (const [colId, f] of Object.entries(model)) {
    rows = rows.filter((o) => columnMatch(o[colId as OrderField], f));
  }
  const groupFields = req.rowGroupCols.map((g) => (g.field ?? g.id) as OrderField);
  const aggs: RefAgg[] = req.valueCols.map((v) => ({
    id: v.id,
    field: (v.field ?? v.id) as OrderField,
    agg: v.aggFunc ?? 'sum',
  }));

  req.groupKeys.forEach((key, d) => {
    const field = groupFields[d] as OrderField;
    const meta = COLUMN_BY_FIELD.get(field) as ColumnMeta;
    rows = rows.filter((o) => groupKeyOf(o, field, meta) === key);
  });

  const depth = req.groupKeys.length;
  let out: Row[];
  let rowCount: number;
  if (depth < groupFields.length) {
    const field = groupFields[depth] as OrderField;
    const meta = COLUMN_BY_FIELD.get(field) as ColumnMeta;
    const buckets = new Map<string, Order[]>();
    for (const o of rows) {
      const k = groupKeyOf(o, field, meta);
      const list = buckets.get(k);
      if (list === undefined) buckets.set(k, [o]);
      else list.push(o);
    }
    const groups = [...buckets.entries()].map(([key, members]) => ({
      key,
      members,
      values: aggs.map((a) => aggregateOf(members, a)),
    }));
    type Applicable = { kind: 'key' | 'agg'; idx: number; dir: 'asc' | 'desc' };
    const applicable = req.sortModel.flatMap((s): Applicable[] => {
      if (s.colId === 'ag-Grid-AutoColumn' || s.colId === field) return [{ kind: 'key', idx: -1, dir: s.sort }];
      const idx = aggs.findIndex((a) => a.id === s.colId);
      return idx >= 0 ? [{ kind: 'agg', idx, dir: s.sort }] : [];
    });
    const tie = applicable.length > 0 && applicable[applicable.length - 1]?.dir === 'desc' ? -1 : 1;
    groups.sort((x, y) => {
      for (const s of applicable) {
        const r = s.kind === 'key' ? cmpValues(x.key, y.key) : cmpValues(x.values[s.idx], y.values[s.idx]);
        if (r !== 0) return s.dir === 'desc' ? -r : r;
      }
      return cmpValues(x.key, y.key) * tie;
    });
    rowCount = groups.length;
    out = groups.map((g) => {
      const row: Row = { [field]: g.key, childCount: g.members.length };
      aggs.forEach((a, j) => {
        row[a.field] = g.values[j] as number | null;
      });
      return row;
    });
  } else {
    const sorted = sortLeaves(rows, req);
    rowCount = sorted.length;
    out = sorted.map((o) => ({ ...o }));
  }
  return { rows: out.slice(req.startRow, req.endRow).map(zeroNormalised), rowCount };
}
