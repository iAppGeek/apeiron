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

export type GroupLevel = {
  field: OrderField;
  /** Group keys in display order. */
  labels: string[];
  /** Child row count per group, in display order. */
  counts: Uint32Array;
  /** `aggs[j][g]` is the aggregate of value column `j` for group `g`; null when every value is null. */
  aggs: (number | null)[][];
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

/** Per-bucket aggregate for one value column; `count` is the row count, the others skip nulls. Rows are visited in ascending row order. */
function aggregate(
  store: ColumnarStore,
  rows: Uint32Array,
  bucketOf: Uint32Array,
  nb: number,
  vc: ValueCol,
): (number | null)[] {
  const m = rows.length;
  if (vc.agg === 'count') {
    // `count` is the group's row count (equal to childCount), never null.
    const counts = new Array<number | null>(nb).fill(0);
    for (let p = 0; p < m; p++) {
      const b = bucketOf[p] as number;
      counts[b] = (counts[b] as number) + 1;
    }
    return counts;
  }
  const col = store.column(vc.field);
  const sum = new Float64Array(nb);
  const cnt = new Float64Array(nb);
  const wsum = new Float64Array(nb);
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
  const out = new Array<number | null>(nb).fill(null);
  for (let b = 0; b < nb; b++) {
    const c = cnt[b] as number;
    if (c === 0) continue;
    switch (vc.agg) {
      case 'sum':
        out[b] = sum[b] as number;
        break;
      case 'avg':
        out[b] = (sum[b] as number) / c;
        break;
      case 'wavg':
        out[b] = (wsum[b] as number) > 0 ? (sum[b] as number) / (wsum[b] as number) : null;
        break;
    }
  }
  return out;
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
  const bucketAggs = valueCols.map((vc) => aggregate(store, rows, buckets.bucketOf, nb, vc));

  const order: number[] = [];
  for (let b = 0; b < nb; b++) if ((bucketCounts[b] as number) > 0) order.push(b);

  const aggVal = (j: number, b: number): number => (bucketAggs[j] as (number | null)[])[b] ?? -Infinity;
  const tieDesc = sortSpec.length > 0 ? (sortSpec[sortSpec.length - 1] as GroupSortSpec).desc : false;
  order.sort((x, y) => {
    for (const s of sortSpec) {
      const d = s.desc ? -1 : 1;
      const r = s.kind === 'key' ? buckets.keyOrder(x) - buckets.keyOrder(y) : aggVal(s.index, x) - aggVal(s.index, y);
      if (r !== 0 && !Number.isNaN(r)) return d * Math.sign(r);
    }
    return (tieDesc ? -1 : 1) * Math.sign(buckets.keyOrder(x) - buckets.keyOrder(y));
  });

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
  const indexByLabel = new Map(labels.map((l, i): [string, number] => [l, i]));
  return {
    field,
    labels,
    counts,
    aggs,
    offsets,
    part,
    indexByLabel,
    bytes: part.byteLength + offsets.byteLength + counts.byteLength + g * (valueCols.length * 8 + 48),
  };
}
