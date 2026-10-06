/** Largest dictionary the 16-bit code columns can address. */
export const MAX_DICTIONARY_SIZE = 65_536;

/**
 * Append-only string dictionary. Codes are assigned in first-seen order. `rank` maps a code to the
 * position of its value in ascending code-unit order, so sorting compares small integers, not strings.
 */
export class Dictionary {
  readonly values: string[] = [];
  private readonly index = new Map<string, number>();
  private rankCache: Uint16Array | null = null;

  get size(): number {
    return this.values.length;
  }

  codeOf(value: string): number | undefined {
    return this.index.get(value);
  }

  /** Returns the code for `value`, adding it when new. Throws once 65,536 distinct values exist. */
  getOrAdd(value: string): number {
    const existing = this.index.get(value);
    if (existing !== undefined) return existing;
    if (this.values.length >= MAX_DICTIONARY_SIZE) {
      throw new Error(`Dictionary overflow: more than ${MAX_DICTIONARY_SIZE} distinct values`);
    }
    const code = this.values.length;
    this.values.push(value);
    this.index.set(value, code);
    this.rankCache = null;
    return code;
  }

  /** `rank[code]` is the sort position of that code's value. Recomputed lazily after new values arrive. */
  get rank(): Uint16Array {
    if (this.rankCache !== null) return this.rankCache;
    const codes = Array.from({ length: this.values.length }, (_, i) => i);
    codes.sort((a, b) => {
      const va = this.values[a] as string;
      const vb = this.values[b] as string;
      return va < vb ? -1 : va > vb ? 1 : 0;
    });
    const rank = new Uint16Array(this.values.length);
    for (let r = 0; r < codes.length; r++) rank[codes[r] as number] = r;
    this.rankCache = rank;
    return rank;
  }

  /** The distinct values in ascending order. */
  sortedValues(): string[] {
    return [...this.values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
}
