/**
 * Sort ranks for a free-text string column. `rank[row]` is the position of the row's string among the
 * distinct values (equal strings share a rank), valid for rows `< built`. Rows appended later have no rank
 * yet; a background refresh extends the ranks without re-sorting every string.
 */
export type RankState = {
  /** Distinct values, ascending. */
  sorted: string[];
  rank: Uint32Array;
  /** Rows `[0, built)` have a rank. */
  built: number;
  /** A covered row's string changed, so the ranks cannot be trusted until a full rebuild. */
  dirty: boolean;
};

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Binary search in an ascending string array: the index of `value`, or -1. */
function indexIn(sorted: readonly string[], value: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] as string) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo < sorted.length && sorted[lo] === value ? lo : -1;
}

/** Full synchronous build over rows `[0, n)`. */
export function buildRankState(data: readonly string[], n: number): RankState {
  const codeOf = new Map<string, number>();
  const codes = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const s = data[i] as string;
    let c = codeOf.get(s);
    if (c === undefined) {
      c = codeOf.size;
      codeOf.set(s, c);
    }
    codes[i] = c;
  }
  const values = [...codeOf.keys()];
  const order = Uint32Array.from({ length: values.length }, (_, i) => i);
  order.sort((a, b) => compare(values[a] as string, values[b] as string));
  const rankOfCode = new Uint32Array(values.length);
  const sorted = new Array<string>(values.length);
  for (let r = 0; r < order.length; r++) {
    rankOfCode[order[r] as number] = r;
    sorted[r] = values[order[r] as number] as string;
  }
  const rank = new Uint32Array(n);
  for (let i = 0; i < n; i++) rank[i] = rankOfCode[codes[i] as number] as number;
  return { sorted, rank, built: n, dirty: false };
}

/**
 * Extends `state` to cover rows `[0, n)` in slices of about `chunk` units of work, yielding between
 * slices so the event loop keeps turning. Existing ranks stay a valid order, so only the values seen since
 * the last build are sorted and merged into the distinct list; rows are then renumbered in a linear pass.
 * Returns the new state, or null when the state was marked dirty meanwhile (the caller rebuilds instead).
 */
export function* refreshRankState(
  state: RankState,
  data: readonly string[],
  n: number,
  chunk: number,
): Generator<void, RankState | null> {
  // 1. Distinct values appended since the last build that are not yet known.
  const fresh = new Set<string>();
  for (let r = state.built; r < n; r++) {
    const s = data[r] as string;
    if (!fresh.has(s) && indexIn(state.sorted, s) < 0) fresh.add(s);
    if ((r - state.built) % chunk === chunk - 1) {
      yield;
      if (state.dirty) return null;
    }
  }
  const add = [...fresh].sort(compare);

  // 2. Merge the new values into the distinct list, remembering where every old value moved.
  const merged: string[] = [];
  const newPos = new Uint32Array(state.sorted.length);
  let j = 0;
  for (let i = 0; i < state.sorted.length; i++) {
    const s = state.sorted[i] as string;
    while (j < add.length && (add[j] as string) < s) merged.push(add[j++] as string);
    newPos[i] = merged.length;
    merged.push(s);
    if (i % chunk === chunk - 1) {
      yield;
      if (state.dirty) return null;
    }
  }
  while (j < add.length) merged.push(add[j++] as string);

  // 3. Renumber the covered rows and rank the new ones.
  const rank = new Uint32Array(n);
  for (let r = 0; r < state.built; r++) {
    rank[r] = newPos[state.rank[r] as number] as number;
    if (r % chunk === chunk - 1) {
      yield;
      if (state.dirty) return null;
    }
  }
  for (let r = state.built; r < n; r++) rank[r] = indexIn(merged, data[r] as string);
  if (state.dirty) return null;
  return { sorted: merged, rank, built: n, dirty: false };
}
