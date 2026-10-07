import { COLUMNS, type Order, type OrderField } from '@apeiron/logos';

const FIELD_INDEX: ReadonlyMap<OrderField, number> = new Map(COLUMNS.map((c, i): [OrderField, number] => [c.field, i]));

/** A set of fields as two 32-bit masks (the order has 50 fields), for cheap intersection tests. */
export type FieldMask = { lo: number; hi: number };

export function maskOf(fields: Iterable<OrderField>): FieldMask {
  let lo = 0;
  let hi = 0;
  for (const f of fields) {
    const i = FIELD_INDEX.get(f);
    if (i === undefined) continue;
    if (i < 30) lo |= 1 << i;
    else hi |= 1 << (i - 30);
  }
  return { lo, hi };
}

export type ChangeEntry = {
  row: number;
  /** The row was appended this tick. */
  isNew: boolean;
  /** Fields whose value differs from the start of the tick. */
  fields: Set<OrderField>;
  /** Values at the start of the tick, for the fields in `fields`. */
  prev: Partial<Order>;
  lo: number;
  hi: number;
};

/**
 * Everything that changed in one flush tick, keyed by row index. `prev` holds each changed field's value
 * from before the tick (the first old value wins when a row changes twice), which is what lets views and
 * aggregates be adjusted without rescanning.
 */
export class ChangeSet {
  readonly entries = new Map<number, ChangeEntry>();

  get size(): number {
    return this.entries.size;
  }

  has(row: number): boolean {
    return this.entries.has(row);
  }

  noteNew(row: number): void {
    const e = this.entries.get(row);
    if (e !== undefined) {
      e.isNew = true;
      return;
    }
    this.entries.set(row, { row, isNew: true, fields: new Set(), prev: {}, lo: 0, hi: 0 });
  }

  noteUpdate(row: number, changed: readonly OrderField[], prev: Partial<Order>): void {
    if (changed.length === 0) return;
    let e = this.entries.get(row);
    if (e === undefined) {
      e = { row, isNew: false, fields: new Set(), prev: {}, lo: 0, hi: 0 };
      this.entries.set(row, e);
    }
    const target = e.prev as Record<string, unknown>;
    const source = prev as Record<string, unknown>;
    for (const f of changed) {
      if (!e.fields.has(f)) {
        e.fields.add(f);
        target[f] = source[f];
        const i = FIELD_INDEX.get(f);
        if (i !== undefined) {
          if (i < 30) e.lo |= 1 << i;
          else e.hi |= 1 << (i - 30);
        }
      }
    }
  }

  /** Previous values for rows that changed this tick (undefined for untouched and new rows). */
  prevOf = (row: number): Partial<Order> | undefined => {
    const e = this.entries.get(row);
    return e === undefined || e.isNew ? undefined : e.prev;
  };
}
