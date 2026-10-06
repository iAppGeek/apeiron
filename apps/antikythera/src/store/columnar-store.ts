import { COLUMNS, type Order, type OrderField, type Row } from '@apeiron/logos';
import { Dictionary } from './dictionary.js';
import { buildRankState, refreshRankState, type RankState } from './string-rank.js';

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
  /** Called when an append breaks ascending `orderId` order (the radix tiebreak shortcut stops being valid). */
  onAscendingBroken?: (orderId: string) => void;
};

/** What an in-place update changed: the changed fields and their previous values (null for a null number). */
export type RowUpdate = { changed: OrderField[]; prev: Partial<Order> };

export type UpsertResult =
  | { kind: 'append'; row: number }
  | ({ kind: 'update'; row: number } & RowUpdate);

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
  private layout = 0;
  private readonly rankStates = new Map<OrderField, RankState>();
  private readonly grownDictionaries = new Set<OrderField>();
  private readonly onAscendingBroken: ((orderId: string) => void) | undefined;

  constructor(options: StoreOptions = {}) {
    this.cap = Math.max(1, options.capacity ?? DEFAULT_STORE_CAPACITY);
    this.onAscendingBroken = options.onAscendingBroken;
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

  /**
   * Bumped when a typed array is reallocated (capacity growth, or an enum column widening to 16-bit codes).
   * Anything that captured a column array, such as a compiled filter, must be rebuilt when this changes.
   * It is not a data version: appends and updates never bump it.
   */
  get layoutVersion(): number {
    return this.layout;
  }

  /** Enum columns whose dictionary gained a value since the last call. */
  takeDictionaryGrowth(): Set<OrderField> {
    const grown = new Set(this.grownDictionaries);
    this.grownDictionaries.clear();
    return grown;
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
   * Complete, current ranks for a string column: builds (or rebuilds) synchronously when the column has
   * none or they are stale. Used at load and in tests; the hot path uses {@link stringRankState}.
   */
  stringRank(field: OrderField): Uint32Array {
    const state = this.rankStates.get(field);
    if (state !== undefined && !state.dirty && state.built === this.count) return state.rank;
    const built = buildRankState(this.stringColumn(field), this.count);
    this.rankStates.set(field, built);
    return built.rank;
  }

  /**
   * The ranks as last built, possibly covering fewer rows than the store holds (`built`), or null when none
   * exist or a string changed under them. Rows `>= built` have no rank.
   */
  stringRankState(field: OrderField): RankState | null {
    const state = this.rankStates.get(field);
    return state === undefined || state.dirty ? null : state;
  }

  /** String columns that have ranks and have fallen behind the store (appended rows, or a changed string). */
  staleRankFields(): OrderField[] {
    const out: OrderField[] = [];
    for (const [field, state] of this.rankStates) if (state.dirty || state.built < this.count) out.push(field);
    return out;
  }

  /**
   * Brings one column's ranks up to date in slices, yielding between them. Run it from a background task:
   * `for (const _ of store.refreshStringRanks(field)) await yieldToLoop()`.
   */
  *refreshStringRanks(field: OrderField, chunk = 50_000): Generator<void> {
    const state = this.rankStates.get(field);
    if (state === undefined) return;
    if (state.dirty) {
      yield;
      this.rankStates.set(field, buildRankState(this.stringColumn(field), this.count));
      return;
    }
    const run = refreshRankState(state, this.stringColumn(field), this.count, chunk);
    let step = run.next();
    while (step.done !== true) {
      yield;
      if (this.rankStates.get(field) !== state) return;
      step = run.next();
    }
    if (step.value !== null && this.rankStates.get(field) === state) this.rankStates.set(field, step.value);
  }

  rowIndexOf(orderId: string): number | undefined {
    return this.idToRow.get(orderId);
  }

  /** Appends orders as new rows. Throws on a duplicate `orderId`. Never invalidates anything else. */
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
        if (!(id > prev) && this.ascendingIds) {
          this.ascendingIds = false;
          this.onAscendingBroken?.(id);
        }
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
        const sizeBefore = col.dict.size;
        for (let i = 0; i < orders.length; i++) {
          const code = col.dict.getOrAdd((orders[i] as Order)[field] as string);
          if (code > 255 && col.codes instanceof Uint8Array) this.widen(col, base + i);
          col.codes[base + i] = code;
        }
        if (col.dict.size !== sizeBefore) this.grownDictionaries.add(field);
      } else {
        const data = col.data;
        for (let i = 0; i < orders.length; i++) data.push((orders[i] as Order)[field] as string);
      }
    }
    this.count += orders.length;
  }

  /** Writes every field of `order` over an existing row, or appends it as a new row. */
  upsert(order: Order): UpsertResult {
    const row = this.idToRow.get(order.orderId);
    if (row === undefined) {
      this.appendBatch([order]);
      return { kind: 'append', row: this.count - 1 };
    }
    return { kind: 'update', row, ...this.updateRow(row, order) };
  }

  /**
   * Writes the given fields of one row in place and reports which actually changed, with their previous
   * values. Fields that already hold the value are not reported. `orderId` and unknown keys are ignored.
   * Nothing global is invalidated; the caller feeds the result to the tick's ChangeSet.
   */
  updateRow(row: number, partial: Partial<Order>): RowUpdate {
    const changed: OrderField[] = [];
    const prev: Record<string, unknown> = {};
    for (const key of Object.keys(partial) as OrderField[]) {
      if (key === 'orderId') continue;
      const col = this.columns.get(key);
      if (col === undefined) continue;
      const value = partial[key];
      if (col.kind === 'number') {
        const next = typeof value === 'number' ? value + 0 : Number.NaN;
        const old = col.data[row] as number;
        if (old === next || (old !== old && next !== next)) continue;
        prev[key] = old !== old ? null : old;
        col.data[row] = next;
        changed.push(key);
      } else if (col.kind === 'enum') {
        const sizeBefore = col.dict.size;
        const code = col.dict.getOrAdd(value as string);
        if (col.dict.size !== sizeBefore) this.grownDictionaries.add(key);
        if (code > 255 && col.codes instanceof Uint8Array) this.widen(col, this.count);
        const oldCode = col.codes[row] as number;
        if (oldCode === code) continue;
        prev[key] = col.dict.values[oldCode];
        col.codes[row] = code;
        changed.push(key);
      } else {
        const next = value as string;
        const old = col.data[row] as string;
        if (old === next) continue;
        prev[key] = old;
        col.data[row] = next;
        const state = this.rankStates.get(key);
        if (state !== undefined && row < state.built) state.dirty = true;
        changed.push(key);
      }
    }
    return { changed, prev: prev as Partial<Order> };
  }

  /** The row as a typed order (the same values as {@link rowAt}). */
  orderAt(index: number): Order {
    return this.rowAt(index) as unknown as Order;
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
    this.layout++;
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
    this.layout++;
  }
}
