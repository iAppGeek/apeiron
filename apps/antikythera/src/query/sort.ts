import type { Order, OrderField } from '@apeiron/logos';
import type { ColumnarStore } from '../store/columnar-store.js';

export type SortKey = { field: OrderField; desc: boolean };

export const DEFAULT_SORT: readonly SortKey[] = [{ field: 'createdAt', desc: true }];

// The radix path reads Float64 bit patterns as little-endian 32-bit words.
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

type Cmp = (a: number, b: number) => number;

/**
 * Sorts `rows` (ascending row indexes) by the sort keys and returns a new array. Nulls are the smallest
 * value (first ascending, last descending). Every sort ends with an `orderId` tiebreaker in the same
 * direction as the last key, so the order is total and block fetches never overlap or skip rows.
 *
 * Fast path: while row order equals `orderId` order, the tiebreak is the starting order, and an LSD
 * radix sort over 16-bit digits (stable) handles number, enum and string keys (strings via a cached
 * rank array). When ids are not ascending in row order it falls back to a comparator sort over the
 * same total order.
 */
export function sortRows(store: ColumnarStore, rows: Uint32Array, keys: readonly SortKey[]): Uint32Array {
  const effective = truncateAtOrderId(keys);
  if (rows.length <= 1 || effective.length === 0) return rows.slice();
  const tieDesc = (effective[effective.length - 1] as SortKey).desc;
  if (LITTLE_ENDIAN && store.idsAscending) {
    const covered = rankCoverage(store, effective);
    if (covered >= store.size) return radixSort(store, rows, effective, tieDesc);
    // The string ranks lag behind appended rows (a background task catches them up). Radix-sort the rows
    // the ranks cover, comparator-sort the few newer ones, and merge. Row indexes are ascending.
    const split = lowerBound(rows, covered);
    const tail = rows.length - split;
    if (split > 0 && tail <= PARTIAL_TAIL_MAX) {
      const head = radixSort(store, rows.subarray(0, split), effective, tieDesc);
      const rest = comparatorSort(store, rows.subarray(split), effective, tieDesc);
      return mergeSorted(head, rest, makeComparator(store, effective));
    }
  }
  return comparatorSort(store, rows, effective, tieDesc);
}

/** Most rows past the string-rank coverage that a sort will merge in rather than fall back to a comparator sort. */
const PARTIAL_TAIL_MAX = 50_000;

/**
 * How many leading rows every string key's ranks cover (Infinity when no key is a string column). A string
 * column that has never been ranked is ranked now, once; after that, appends only make it stale.
 */
function rankCoverage(store: ColumnarStore, keys: readonly SortKey[]): number {
  let covered = Number.POSITIVE_INFINITY;
  for (const key of keys) {
    if (key.field === 'orderId') continue;
    const col = store.column(key.field);
    if (col.kind !== 'string') continue;
    let state = store.stringRankState(key.field);
    if (state === null) {
      store.stringRank(key.field);
      state = store.stringRankState(key.field);
    }
    covered = Math.min(covered, state === null ? 0 : state.built);
  }
  return covered;
}

function lowerBound(rows: Uint32Array, value: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((rows[mid] as number) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function mergeSorted(a: Uint32Array, b: Uint32Array, cmp: Cmp): Uint32Array {
  const out = new Uint32Array(a.length + b.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.length && j < b.length) out[k++] = cmp(a[i] as number, b[j] as number) <= 0 ? (a[i++] as number) : (b[j++] as number);
  while (i < a.length) out[k++] = a[i++] as number;
  while (j < b.length) out[k++] = b[j++] as number;
  return out;
}

/** `orderId` is unique, so keys after it can never matter. */
function truncateAtOrderId(keys: readonly SortKey[]): SortKey[] {
  const i = keys.findIndex((k) => k.field === 'orderId');
  return i < 0 ? [...keys] : keys.slice(0, i + 1);
}

function radixSort(
  store: ColumnarStore,
  rows: Uint32Array,
  keys: readonly SortKey[],
  tieDesc: boolean,
): Uint32Array {
  const m = rows.length;
  let src = new Uint32Array(m);
  let dst = new Uint32Array(m);
  if (tieDesc) for (let i = 0; i < m; i++) src[i] = m - 1 - i;
  else for (let i = 0; i < m; i++) src[i] = i;
  const counts = new Uint32Array(65_536);

  for (let k = keys.length - 1; k >= 0; k--) {
    const key = keys[k] as SortKey;
    if (key.field === 'orderId') continue; // already encoded by the starting order
    const col = store.column(key.field);
    if (col.kind === 'enum') {
      const rank = col.dict.rank;
      const last = col.dict.size - 1;
      const words = new Uint32Array(m);
      for (let p = 0; p < m; p++) {
        const r = rank[col.codes[rows[p] as number] as number] as number;
        words[p] = key.desc ? last - r : r;
      }
      if (radixPass(src, dst, words, 0, counts)) [src, dst] = [dst, src];
    } else if (col.kind === 'string') {
      const rank = (store.stringRankState(key.field) as { rank: Uint32Array }).rank;
      let max = 0;
      const words = new Uint32Array(m);
      for (let p = 0; p < m; p++) {
        const r = rank[rows[p] as number] as number;
        words[p] = r;
        if (r > max) max = r;
      }
      if (key.desc) for (let p = 0; p < m; p++) words[p] = max - (words[p] as number);
      if (radixPass(src, dst, words, 0, counts)) [src, dst] = [dst, src];
      if (radixPass(src, dst, words, 16, counts)) [src, dst] = [dst, src];
    } else if (col.kind === 'number') {
      const { hi, lo } = orderedWords(col.data, rows, key.desc);
      for (const [words, shift] of [
        [lo, 0],
        [lo, 16],
        [hi, 0],
        [hi, 16],
      ] as const) {
        if (radixPass(src, dst, words, shift, counts)) [src, dst] = [dst, src];
      }
    }
  }
  const out = new Uint32Array(m);
  for (let i = 0; i < m; i++) out[i] = rows[src[i] as number] as number;
  return out;
}

/**
 * Maps each double to a 64-bit unsigned key (as hi/lo words, by position in `rows`) whose unsigned
 * order equals the numeric order, with NaN smallest and -0 equal to 0. Descending inverts every bit.
 */
function orderedWords(
  data: Float64Array,
  rows: Uint32Array,
  desc: boolean,
): { hi: Uint32Array; lo: Uint32Array } {
  const m = rows.length;
  const bits = new Uint32Array(data.buffer, data.byteOffset, data.length * 2);
  const hi = new Uint32Array(m);
  const lo = new Uint32Array(m);
  for (let p = 0; p < m; p++) {
    const r = rows[p] as number;
    const v = data[r] as number;
    let h: number;
    let l: number;
    if (v !== v) {
      h = 0;
      l = 0;
    } else if (v === 0) {
      h = 0x80000000;
      l = 0;
    } else {
      h = bits[2 * r + 1] as number;
      l = bits[2 * r] as number;
      if (h & 0x80000000) {
        h = ~h >>> 0;
        l = ~l >>> 0;
      } else {
        h = (h | 0x80000000) >>> 0;
      }
    }
    if (desc) {
      h = ~h >>> 0;
      l = ~l >>> 0;
    }
    hi[p] = h;
    lo[p] = l;
  }
  return { hi, lo };
}

/** One stable counting-sort pass on a 16-bit digit. Returns false (and does nothing) when every digit is equal. */
function radixPass(
  src: Uint32Array,
  dst: Uint32Array,
  words: Uint32Array,
  shift: number,
  counts: Uint32Array,
): boolean {
  const m = src.length;
  counts.fill(0);
  for (let p = 0; p < m; p++) counts[((words[p] as number) >>> shift) & 0xffff]!++;
  if (counts[((words[0] as number) >>> shift) & 0xffff] === m) return false;
  let sum = 0;
  for (let d = 0; d < 65_536; d++) {
    const c = counts[d] as number;
    counts[d] = sum;
    sum += c;
  }
  for (let i = 0; i < m; i++) {
    const p = src[i] as number;
    const d = ((words[p] as number) >>> shift) & 0xffff;
    dst[counts[d] as number] = p;
    counts[d] = (counts[d] as number) + 1;
  }
  return true;
}

/** Old values of changed rows: returns the previous values of the fields that changed for `row`, if any. */
export type PrevOf = (row: number) => Partial<Order> | undefined;

function keyComparator(store: ColumnarStore, key: SortKey, prevOf?: PrevOf): Cmp {
  const col = store.column(key.field);
  const field = key.field;
  const dir = key.desc ? -1 : 1;
  if (col.kind === 'number') {
    const data = col.data;
    const get =
      prevOf === undefined
        ? (r: number): number => data[r] as number
        : (r: number): number => {
            const p = prevOf(r);
            if (p !== undefined && field in p) {
              const v = p[field] as number | null | undefined;
              return typeof v === 'number' ? v : Number.NaN;
            }
            return data[r] as number;
          };
    return (a, b) => {
      const x = get(a);
      const y = get(b);
      if (x === y) return 0;
      if (x !== x) return y !== y ? 0 : -dir;
      if (y !== y) return dir;
      return x < y ? -dir : dir;
    };
  }
  if (col.kind === 'enum') {
    const rank = col.dict.rank;
    const codes = col.codes;
    const dict = col.dict;
    const get =
      prevOf === undefined
        ? (r: number): number => rank[codes[r] as number] as number
        : (r: number): number => {
            const p = prevOf(r);
            if (p !== undefined && field in p) {
              const code = dict.codeOf(p[field] as string);
              return code === undefined ? -1 : (rank[code] as number);
            }
            return rank[codes[r] as number] as number;
          };
    return (a, b) => dir * (get(a) - get(b));
  }
  const data = col.data;
  const get =
    prevOf === undefined
      ? (r: number): string => data[r] as string
      : (r: number): string => {
          const p = prevOf(r);
          return p !== undefined && field in p ? (p[field] as string) : (data[r] as string);
        };
  return (a, b) => {
    const x = get(a);
    const y = get(b);
    return x === y ? 0 : x < y ? -dir : dir;
  };
}

/**
 * The total order {@link sortRows} produces, as a comparator over row indexes: the sort keys, then the
 * `orderId` tiebreak in the direction of the last key. With `prevOf`, rows that have a previous value for
 * a sort field are compared by that old value, so a row can be located where it sat before it changed.
 */
export function makeComparator(store: ColumnarStore, keys: readonly SortKey[], prevOf?: PrevOf): Cmp {
  const effective = truncateAtOrderId(keys);
  const tieDir = effective.length > 0 && (effective[effective.length - 1] as SortKey).desc ? -1 : 1;
  const cmps = effective.filter((k) => k.field !== 'orderId').map((k) => keyComparator(store, k, prevOf));
  if (store.idsAscending) {
    return (a, b) => {
      for (let i = 0; i < cmps.length; i++) {
        const r = (cmps[i] as Cmp)(a, b);
        if (r !== 0) return r;
      }
      return a === b ? 0 : a < b ? -tieDir : tieDir;
    };
  }
  const ids = store.stringColumn('orderId');
  return (a, b) => {
    for (let i = 0; i < cmps.length; i++) {
      const r = (cmps[i] as Cmp)(a, b);
      if (r !== 0) return r;
    }
    const x = ids[a] as string;
    const y = ids[b] as string;
    return x === y ? 0 : x < y ? -tieDir : tieDir;
  };
}

function comparatorSort(
  store: ColumnarStore,
  rows: Uint32Array,
  keys: readonly SortKey[],
  tieDesc: boolean,
): Uint32Array {
  const cmps = keys.map((k) => keyComparator(store, k));
  const ids = store.stringColumn('orderId');
  const tieDir = tieDesc ? -1 : 1;
  const out = rows.slice();
  out.sort((a, b) => {
    for (let i = 0; i < cmps.length; i++) {
      const r = (cmps[i] as Cmp)(a, b);
      if (r !== 0) return r;
    }
    const x = ids[a] as string;
    const y = ids[b] as string;
    return x === y ? 0 : x < y ? -tieDir : tieDir;
  });
  return out;
}
