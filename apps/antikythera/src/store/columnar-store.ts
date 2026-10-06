import { COLUMNS, type Order, type OrderField, type Row } from '@apeiron/logos';
import { Dictionary } from './dictionary.js';

export type NumberColumn = { kind: 'number'; field: OrderField; data: Float64Array };
export type EnumColumn = {
  kind: 'enum';
  field: OrderField;
  dict: Dictionary;
  codes: Uint8Array | Uint16Array;
};
export type StringColumn = { kind: 'string'; field: OrderField; data: string[] };
export type Column = NumberColumn | EnumColumn | StringColumn;

export type ColumnMemory = {
  field: OrderField;
  kind: Column['kind'];
  /** Bytes holding the rows currently stored (typed arrays only; 0 for string columns). */
  usedBytes: number;
  /** Bytes reserved for the full capacity (virtual until written). */
  reservedBytes: number;
  dictionarySize?: number;
  /** Rough heap estimate for string columns: header + payload + pointer per string. */
  estimatedHeapBytes?: number;
};

export type StoreMemory = {
  rows: number;
  capacity: number;
  columns: ColumnMemory[];
  typedUsedBytes: number;
  typedReservedBytes: number;
  estimatedStringHeapBytes: number;
};

export type StoreOptions = {
  /** Rows to reserve up front. Typed arrays are SharedArrayBuffer-backed and grow by 1.5x beyond this. */
  capacity?: number;
};

export const DEFAULT_STORE_CAPACITY = 1_500_000;

const newF64 = (capacity: number): Float64Array => new Float64Array(new SharedArrayBuffer(capacity * 8));
const newCodes = (capacity: number, wide: boolean): Uint8Array | Uint16Array =>
  wide
    ? new Uint16Array(new SharedArrayBuffer(capacity * 2))
    : new Uint8Array(new SharedArrayBuffer(capacity));

/**
 * Columnar in-memory order store. Numbers and dates are Float64 (null is NaN, -0 is stored as 0), enum
 * columns are dictionary codes with a rank array, identifier-like strings stay as `string[]`. Every
 * typed array lives on a SharedArrayBuffer so a worker could take over view building later (Appendix F).
 * Row objects are only built for the blocks that are sent.
 */
export class ColumnarStore {
  readonly columns: ReadonlyMap<OrderField, Column>;
  private readonly columnList: Column[];
  private readonly idToRow = new Map<string, number>();
  private count = 0;
  private cap: number;
  private ascendingIds = true;
  private versionCounter = 0;
  private readonly stringRankCache = new Map<OrderField, { version: number; rank: Uint32Array }>();

  constructor(options: StoreOptions = {}) {
    this.cap = Math.max(1, options.capacity ?? DEFAULT_STORE_CAPACITY);
    this.columnList = COLUMNS.map((meta): Column => {
      switch (meta.type) {
        case 'enum':
          return { kind: 'enum', field: meta.field, dict: new Dictionary(), codes: newCodes(this.cap, false) };
        case 'string':
          return { kind: 'string', field: meta.field, data: [] };
        default:
          return { kind: 'number', field: meta.field, data: newF64(this.cap) };
      }
    });
    this.columns = new Map(this.columnList.map((c): [OrderField, Column] => [c.field, c]));
  }

  get size(): number {
    return this.count;
  }

  get capacity(): number {
    return this.cap;
  }

  /** True while row index order equals ascending `orderId` order, which lets sorts use row order as the tiebreaker. */
  get idsAscending(): boolean {
    return this.ascendingIds;
  }

  /** Bumped by every append; cached views are only valid for the version they were built at. */
  get version(): number {
    return this.versionCounter;
  }

  column(field: OrderField): Column {
    const c = this.columns.get(field);
    if (c === undefined) throw new Error(`Unknown column: ${field}`);
    return c;
  }

  numberColumn(field: OrderField): Float64Array {
    const c = this.column(field);
    if (c.kind !== 'number') throw new Error(`${field} is not a number column`);
    return c.data;
  }

  enumColumn(field: OrderField): EnumColumn {
    const c = this.column(field);
    if (c.kind !== 'enum') throw new Error(`${field} is not an enum column`);
    return c;
  }

  stringColumn(field: OrderField): string[] {
    const c = this.column(field);
    if (c.kind !== 'string') throw new Error(`${field} is not a string column`);
    return c.data;
  }

  /**
   * `rank[row]` is the sort position of the row's string among all values of a string column (equal
   * strings share a rank). Built on first use and rebuilt after an append; lets string sorts use radix.
   */
  stringRank(field: OrderField): Uint32Array {
    const cached = this.stringRankCache.get(field);
    if (cached !== undefined && cached.version === this.versionCounter) return cached.rank;
    const data = this.stringColumn(field);
    const n = this.count;
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
    order.sort((a, b) => ((values[a] as string) < (values[b] as string) ? -1 : 1));
    const rankOfCode = new Uint32Array(values.length);
    for (let r = 0; r < order.length; r++) rankOfCode[order[r] as number] = r;
    const rank = new Uint32Array(n);
    for (let i = 0; i < n; i++) rank[i] = rankOfCode[codes[i] as number] as number;
    this.stringRankCache.set(field, { version: this.versionCounter, rank });
    return rank;
  }

  rowIndexOf(orderId: string): number | undefined {
    return this.idToRow.get(orderId);
  }

  /** Appends orders as new rows. Throws on a duplicate `orderId`. */
  appendBatch(orders: readonly Order[]): void {
    if (orders.length === 0) return;
    this.ensureCapacity(this.count + orders.length);
    const base = this.count;
    const ids = this.stringColumn('orderId');
    const seen = new Set<string>();
    for (let i = 0; i < orders.length; i++) {
      const id = (orders[i] as Order).orderId;
      if (this.idToRow.has(id) || seen.has(id)) throw new Error(`Duplicate orderId: ${id}`);
      seen.add(id);
      if (base + i > 0) {
        const prev = i === 0 ? (ids[base - 1] as string) : (orders[i - 1] as Order).orderId;
        if (!(id > prev)) this.ascendingIds = false;
      }
    }
    for (let i = 0; i < orders.length; i++) this.idToRow.set((orders[i] as Order).orderId, base + i);
    for (const col of this.columnList) {
      const field = col.field;
      if (col.kind === 'number') {
        const data = col.data;
        for (let i = 0; i < orders.length; i++) {
          const v = (orders[i] as Order)[field] as number | null;
          data[base + i] = typeof v === 'number' ? v + 0 : Number.NaN;
        }
      } else if (col.kind === 'enum') {
        for (let i = 0; i < orders.length; i++) {
          const code = col.dict.getOrAdd((orders[i] as Order)[field] as string);
          if (code > 255 && col.codes instanceof Uint8Array) this.widen(col, base + i);
          col.codes[base + i] = code;
        }
      } else {
        const data = col.data;
        for (let i = 0; i < orders.length; i++) data.push((orders[i] as Order)[field] as string);
      }
    }
    this.count += orders.length;
    this.versionCounter++;
  }

  /** Builds the full 50-field row, restoring null from NaN. */
  rowAt(index: number): Row {
    const row: Row = {};
    for (const col of this.columnList) row[col.field] = this.valueAt(col, index);
    return row;
  }

  /** Materialises `indices[from..to)` as rows. */
  materialize(indices: ArrayLike<number>, from: number, to: number): Row[] {
    const out: Row[] = [];
    const end = Math.min(to, indices.length);
    for (let i = Math.max(0, from); i < end; i++) out.push(this.rowAt(indices[i] as number));
    return out;
  }

  /** Value of one cell as it appears on the wire. */
  valueAt(col: Column, index: number): string | number | null {
    switch (col.kind) {
      case 'number': {
        const v = col.data[index] as number;
        return Number.isNaN(v) ? null : v;
      }
      case 'enum':
        return col.dict.values[col.codes[index] as number] as string;
      default:
        return col.data[index] as string;
    }
  }

  memory(): StoreMemory {
    let typedUsed = 0;
    let typedReserved = 0;
    let stringHeap = 0;
    const columns = this.columnList.map((col): ColumnMemory => {
      if (col.kind === 'number') {
        const used = this.count * 8;
        const reserved = col.data.byteLength;
        typedUsed += used;
        typedReserved += reserved;
        return { field: col.field, kind: 'number', usedBytes: used, reservedBytes: reserved };
      }
      if (col.kind === 'enum') {
        const used = this.count * col.codes.BYTES_PER_ELEMENT;
        const reserved = col.codes.byteLength;
        typedUsed += used;
        typedReserved += reserved;
        return {
          field: col.field,
          kind: 'enum',
          usedBytes: used,
          reservedBytes: reserved,
          dictionarySize: col.dict.size,
        };
      }
      let heap = 0;
      for (const s of col.data) heap += 16 + Math.ceil(s.length / 8) * 8 + 8;
      stringHeap += heap;
      return { field: col.field, kind: 'string', usedBytes: 0, reservedBytes: 0, estimatedHeapBytes: heap };
    });
    return {
      rows: this.count,
      capacity: this.cap,
      columns,
      typedUsedBytes: typedUsed,
      typedReservedBytes: typedReserved,
      estimatedStringHeapBytes: stringHeap,
    };
  }

  /** Switches an enum column to 16-bit codes, keeping the `written` rows stored so far (including this batch's). */
  private widen(col: EnumColumn, written: number): void {
    const wide = newCodes(this.cap, true);
    wide.set(col.codes.subarray(0, written));
    col.codes = wide;
  }

  private ensureCapacity(needed: number): void {
    if (needed <= this.cap) return;
    const next = Math.max(needed, Math.ceil(this.cap * 1.5));
    for (const col of this.columnList) {
      if (col.kind === 'number') {
        const grown = newF64(next);
        grown.set(col.data.subarray(0, this.count));
        col.data = grown;
      } else if (col.kind === 'enum') {
        const grown = newCodes(next, col.codes instanceof Uint16Array);
        grown.set(col.codes.subarray(0, this.count));
        col.codes = grown;
      }
    }
    this.cap = next;
  }
}
