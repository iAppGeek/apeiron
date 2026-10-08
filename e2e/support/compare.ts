export type FieldDiff = { field: string; expected: unknown; actual: unknown };

export type DiffOptions = {
  /** Fields to leave out of the comparison. */
  excluded?: ReadonlySet<string>;
  /** Relative tolerance for numbers (default 0: exact). */
  tolerance?: number;
};

/** `undefined` and `null` both mean "no value" on the wire. */
const norm = (value: unknown): unknown => (value === undefined ? null : value);

const same = (actual: unknown, expected: unknown, tolerance: number): boolean => {
  const a = norm(actual);
  const e = norm(expected);
  if (a === e) return true;
  if (typeof a === 'number' && typeof e === 'number') {
    if (Number.isNaN(a) && Number.isNaN(e)) return true;
    if (tolerance > 0) return Math.abs(a - e) <= tolerance * Math.max(1, Math.abs(a), Math.abs(e));
  }
  return false;
};

/**
 * Compares `actual` (what was read) with `expected` over the keys of `actual`, because the wire row defines which
 * fields exist. A key `actual` lacks but `expected` has counts as a difference only when `strictKeys` is set.
 */
export function diffRecords(
  actual: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, unknown>>,
  options: DiffOptions = {},
  strictKeys = false,
): FieldDiff[] {
  const excluded = options.excluded ?? new Set<string>();
  const tolerance = options.tolerance ?? 0;
  const keys = new Set<string>(Object.keys(actual));
  if (strictKeys) for (const key of Object.keys(expected)) keys.add(key);
  const diffs: FieldDiff[] = [];
  for (const key of keys) {
    if (excluded.has(key)) continue;
    if (!strictKeys && !(key in expected)) continue;
    if (!same(actual[key], expected[key], tolerance)) diffs.push({ field: key, expected: norm(expected[key]), actual: norm(actual[key]) });
  }
  return diffs;
}

/** Splits sorted indexes into maximal runs of consecutive values: `[3,4,5,9]` gives `[{start:3,end:6},{start:9,end:10}]`. */
export function contiguousRuns(sorted: readonly number[]): { start: number; end: number }[] {
  const runs: { start: number; end: number }[] = [];
  for (const index of sorted) {
    const last = runs.at(-1);
    if (last !== undefined && index === last.end) last.end = index + 1;
    else if (last === undefined || index > last.end) runs.push({ start: index, end: index + 1 });
  }
  return runs;
}

/** A readable one-line description of the first few diffs, for failure messages. */
export function describeDiffs(subject: string, diffs: readonly FieldDiff[], limit = 4): string {
  const shown = diffs.slice(0, limit).map((d) => `${d.field}: expected ${JSON.stringify(d.expected)} got ${JSON.stringify(d.actual)}`);
  return `${subject}: ${shown.join('; ')}${diffs.length > limit ? ` (+${diffs.length - limit} more)` : ''}`;
}
