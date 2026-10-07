import { COLUMN_BY_FIELD, type OrderField } from '@apeiron/logos';
import type { ColumnarStore } from '../store/columnar-store.js';
import type { ValueCol } from './request.js';

export const BLANK_KEY = '(blank)';
const DAY_MS = 86_400_000;
const MAX_DAY_BUCKETS = 1 << 22;

/** How group rows at one level are ordered, most significant first. Ties end with the key. */
export type GroupSortSpec =
  | { kind: 'key'; desc: boolean }
  | { kind: 'agg'; index: number; desc: boolean };

/** Running sums for one value column, indexed by group: enough to finalise sum, avg and wavg, and to adjust them. */
export type AggAccum = { sum: Float64Array; cnt: Float64Array; wsum: Float64Array };

export type GroupLevel = {
  field: OrderField;
  /** Group keys in display order. */
  labels: string[];
  /** Child row count per group, in display order. */
  counts: Uint32Array;
  /** `aggs[j][g]` is the aggregate of value column `j` for group `g`; null when every value is null. */
  aggs: (number | null)[][];
  /** `accum[j]` holds the running sums behind `aggs[j]`, by group in display order. */
  accum: AggAccum[];
  /** Rows of group `g` are `part[offsets[g] .. offsets[g + 1])`, ascending by row index. */
  offsets: Uint32Array;
  part: Uint32Array;
  indexByLabel: Map<string, number>;
  bytes: number;
};

type Buckets = {
  bucketOf: Uint32Array;
  count: number;
  label: (b: number) => string;
  /** Orders buckets by key; null group values sort first. */
  keyOrder: (b: number) => number;
};

/** `YYYY-MM-DD` (UTC) for a day number since the epoch. */
export function dayKey(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function bucketize(store: ColumnarStore, rows: Uint32Array, field: OrderField): Buckets {
  const col = store.column(field);
  const m = rows.length;
  const bucketOf = new Uint32Array(m);
  if (col.kind === 'enum') {
    const { codes, dict } = col;
    for (let p = 0; p < m; p++) bucketOf[p] = codes[rows[p] as number] as number;
    const rank = dict.rank;
    return {
      bucketOf,
      count: dict.size,
      label: (b) => dict.values[b] as string,
      keyOrder: (b) => rank[b] as number,
    };
  }
  if (col.kind === 'number' && COLUMN_BY_FIELD.get(field)?.type === 'date') {
    const data = col.data;
    let min = Infinity;
    let max = -Infinity;
    for (let p = 0; p < m; p++) {
      const v = data[rows[p] as number] as number;
      if (v === v) {
        const d = Math.floor(v / DAY_MS);
        if (d < min) min = d;
        if (d > max) max = d;
      }
    }
    const span = max >= min ? max - min + 1 : 0;
    if (span > MAX_DAY_BUCKETS) throw new Error(`Too many distinct days to group ${field}`);
    for (let p = 0; p < m; p++) {
      const v = data[rows[p] as number] as number;
      bucketOf[p] = v === v ? Math.floor(v / DAY_MS) - min : span;
    }
    return {
      bucketOf,
      count: span + 1,
      label: (b) => (b === span ? BLANK_KEY : dayKey(b + min)),
      keyOrder: (b) => (b === span ? -1 : b),
    };
  }
  throw new Error(`Column ${field} cannot be grouped`);
}

/** Final value of one aggregate from its running sums (`count` is the group's row count and never null). */
export function finalizeAgg(agg: ValueCol['agg'], sum: number, cnt: number, wsum: number, rowCount: number): number | null {
  if (agg === 'count') return rowCount;
  if (cnt === 0) return null;
  switch (agg) {
    case 'sum':
      return sum;
    case 'avg':
      return sum / cnt;
    case 'wavg':
      return wsum > 0 ? sum / wsum : null;
  }
}

/** Per-bucket running sums for one value column; nulls are skipped (and `count` needs none). Rows are visited in ascending row order. */
function accumulate(
  store: ColumnarStore,
  rows: Uint32Array,
  bucketOf: Uint32Array,
  nb: number,
  vc: ValueCol,
): AggAccum {
  const m = rows.length;
  const sum = new Float64Array(nb);
  const cnt = new Float64Array(nb);
  const wsum = new Float64Array(nb);
  if (vc.agg === 'count') return { sum, cnt, wsum };
  const col = store.column(vc.field);
  if (col.kind === 'number') {
    const data = col.data;
    if (vc.agg === 'wavg') {
      const w = store.numberColumn('notionalUsd');
      for (let p = 0; p < m; p++) {
        const r = rows[p] as number;
        const v = data[r] as number;
        const wt = w[r] as number;
        if (v === v && wt === wt) {
          const b = bucketOf[p] as number;
          sum[b] = (sum[b] as number) + wt * v;
          wsum[b] = (wsum[b] as number) + wt;
          cnt[b] = (cnt[b] as number) + 1;
        }
      }
    } else {
      for (let p = 0; p < m; p++) {
        const v = data[rows[p] as number] as number;
        if (v === v) {
          const b = bucketOf[p] as number;
          sum[b] = (sum[b] as number) + v;
          cnt[b] = (cnt[b] as number) + 1;
        }
      }
    }
  } else {
    for (let p = 0; p < m; p++) {
      const b = bucketOf[p] as number;
      cnt[b] = (cnt[b] as number) + 1;
    }
  }
  return { sum, cnt, wsum };
}

/** The group key of a raw column value (`YYYY-MM-DD` for dates, `(blank)` for a null date). */
export function labelOfValue(field: OrderField, value: unknown): string {
  if (COLUMN_BY_FIELD.get(field)?.type === 'date') {
    return typeof value === 'number' && value === value ? dayKey(Math.floor(value / DAY_MS)) : BLANK_KEY;
  }
  return value as string;
}

/**
 * The comparator that orders group rows: sort entries in turn (a key or an aggregate, each ascending or
 * descending), ties ending with the key in the direction of the last entry. Shared by the full build and
 * the incremental update so both always agree on the order.
 */
export function groupOrderComparator<T>(
  sortSpec: readonly GroupSortSpec[],
  keyOrder: (item: T) => number,
  aggValue: (index: number, item: T) => number,
): (x: T, y: T) => number {
  const tieDesc = sortSpec.length > 0 ? (sortSpec[sortSpec.length - 1] as GroupSortSpec).desc : false;
  return (x, y) => {
    for (const s of sortSpec) {
      const d = s.desc ? -1 : 1;
      const r = s.kind === 'key' ? keyOrder(x) - keyOrder(y) : aggValue(s.index, x) - aggValue(s.index, y);
      if (r !== 0 && !Number.isNaN(r)) return d * Math.sign(r);
    }
    return (tieDesc ? -1 : 1) * Math.sign(keyOrder(x) - keyOrder(y));
  };
}

/**
 * Groups `rows` (ascending row indexes) by `field`: group keys, child counts, aggregates for the value
 * columns, group order from `sortSpec`, and the rows partitioned per group in display order.
 */
export function buildGroupLevel(
  store: ColumnarStore,
  rows: Uint32Array,
  field: OrderField,
  valueCols: readonly ValueCol[],
  sortSpec: readonly GroupSortSpec[],
): GroupLevel {
  const m = rows.length;
  const buckets = bucketize(store, rows, field);
  const nb = buckets.count;
  const bucketCounts = new Uint32Array(nb);
  for (let p = 0; p < m; p++) {
    const b = buckets.bucketOf[p] as number;
    bucketCounts[b] = (bucketCounts[b] as number) + 1;
  }
  const bucketAccum = valueCols.map((vc) => accumulate(store, rows, buckets.bucketOf, nb, vc));
  const bucketAggs = valueCols.map((vc, j) => {
    const a = bucketAccum[j] as AggAccum;
    return Array.from({ length: nb }, (_, b) =>
      finalizeAgg(vc.agg, a.sum[b] as number, a.cnt[b] as number, a.wsum[b] as number, bucketCounts[b] as number),
    );
  });

  const order: number[] = [];
  for (let b = 0; b < nb; b++) if ((bucketCounts[b] as number) > 0) order.push(b);

  const aggVal = (j: number, b: number): number => (bucketAggs[j] as (number | null)[])[b] ?? -Infinity;
  order.sort(groupOrderComparator<number>(sortSpec, (b) => buckets.keyOrder(b), aggVal));

  const g = order.length;
  const labels = order.map((b) => buckets.label(b));
  const counts = new Uint32Array(g);
  const offsets = new Uint32Array(g + 1);
  const displayOf = new Int32Array(nb).fill(-1);
  order.forEach((b, i) => {
    displayOf[b] = i;
    counts[i] = bucketCounts[b] as number;
    offsets[i + 1] = (offsets[i] as number) + (counts[i] as number);
  });
  const cursor = offsets.slice(0, g);
  const part = new Uint32Array(m);
  for (let p = 0; p < m; p++) {
    const d = displayOf[buckets.bucketOf[p] as number] as number;
    part[cursor[d] as number] = rows[p] as number;
    cursor[d] = (cursor[d] as number) + 1;
  }
  const aggs = bucketAggs.map((a) => order.map((b) => a[b] as number | null));
  const accum = bucketAccum.map(
    (a): AggAccum => ({
      sum: Float64Array.from(order, (b) => a.sum[b] as number),
      cnt: Float64Array.from(order, (b) => a.cnt[b] as number),
      wsum: Float64Array.from(order, (b) => a.wsum[b] as number),
    }),
  );
  const indexByLabel = new Map(labels.map((l, i): [string, number] => [l, i]));
  return {
    field,
    labels,
    counts,
    aggs,
    accum,
    offsets,
    part,
    indexByLabel,
    bytes: part.byteLength + offsets.byteLength + counts.byteLength + g * (valueCols.length * 8 + 48),
  };
}
