/**
 * A growable `Uint32Array` of row indexes with in-place removal and insertion by position. Removing and
 * inserting move whole segments with `copyWithin`, so a tick's worth of changes costs one native memmove
 * per change rather than a JavaScript pass over the array.
 */
export class RowBuf {
  buf: Uint32Array;
  len: number;

  /** Takes ownership of `init` (no copy); its length is the initial size. */
  constructor(init: Uint32Array) {
    this.buf = init;
    this.len = init.length;
  }

  static empty(): RowBuf {
    return new RowBuf(new Uint32Array(0));
  }

  /** The live contents. Re-read after every mutation: growth reallocates. */
  get view(): Uint32Array {
    return this.buf.subarray(0, this.len);
  }

  get bytes(): number {
    return this.buf.byteLength;
  }

  at(i: number): number {
    return this.buf[i] as number;
  }

  /** First index whose value is not less than `value`, for arrays kept in ascending order. */
  lowerBound(value: number): number {
    let lo = 0;
    let hi = this.len;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.buf[mid] as number) < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Whether an ascending array contains `value`. */
  contains(value: number): boolean {
    const i = this.lowerBound(value);
    return i < this.len && this.buf[i] === value;
  }

  /** Removes the elements at the given ascending, distinct positions. */
  removeAt(positions: readonly number[]): void {
    const k = positions.length;
    if (k === 0) return;
    let write = positions[0] as number;
    for (let i = 0; i < k; i++) {
      const from = (positions[i] as number) + 1;
      const to = i + 1 < k ? (positions[i + 1] as number) : this.len;
      this.buf.copyWithin(write, from, to);
      write += to - from;
    }
    this.len = write;
  }

  /**
   * Inserts `items[i]` before the element at original position `positions[i]` (positions ascending and
   * refer to the array before any insertion; `len` means append). Equal positions keep item order.
   */
  insertAt(items: readonly number[], positions: readonly number[]): void {
    const k = items.length;
    if (k === 0) return;
    this.reserve(this.len + k);
    let end = this.len;
    for (let i = k - 1; i >= 0; i--) {
      const p = positions[i] as number;
      this.buf.copyWithin(p + i + 1, p, end);
      this.buf[p + i] = items[i] as number;
      end = p;
    }
    this.len += k;
  }

  private reserve(needed: number): void {
    if (needed <= this.buf.length) return;
    const grown = new Uint32Array(Math.max(needed, Math.ceil(this.buf.length * 1.5), 16));
    grown.set(this.buf.subarray(0, this.len));
    this.buf = grown;
  }

  /** Appends ascending values known to be larger than everything held (the identity array grows this way). */
  appendRange(from: number, to: number): void {
    if (to <= from) return;
    this.reserve(this.len + (to - from));
    for (let v = from; v < to; v++) this.buf[this.len++] = v;
  }
}
