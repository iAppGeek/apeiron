import type { IRowNode } from 'ag-grid-community';

export type TickDirection = 'up' | 'down';

type TickEntry = { dir: TickDirection; prev: number; until: number };
type TickRow = { node: IRowNode; fields: Map<string, TickEntry> };

export type ExpiredTicks = { node: IRowNode; fields: string[] };

export type TickTracker = {
  /** Records a price change. Ignored unless both values are finite numbers and differ. */
  note(node: IRowNode, field: string, prev: unknown, next: unknown, now: number): void;
  /** Direction of the cell's latest change while it is still inside the hold window, else null. */
  direction(rowId: string | undefined, field: string, now?: number): TickDirection | null;
  /** The previous value recorded for a cell, if it is still tracked. */
  previous(rowId: string, field: string): number | undefined;
  /** Removes entries whose hold window has passed and returns what expired, so the cells can be redrawn. */
  expire(now: number): ExpiredTicks[];
  clear(): void;
  readonly size: number;
};

export type TickTrackerOptions = {
  /** How long a cell keeps its up or down colour after its last change. */
  holdMs: number;
  now: () => number;
};

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Tracks the direction of the latest change of each price cell, keyed by row id and field, with the previous
 * value. AG Grid's own flash cannot tell up from down, so the price columns read `direction` in a cell class
 * rule, and the delta applier redraws just the cells that expire.
 */
export function createTickTracker(options: TickTrackerOptions): TickTracker {
  const rows = new Map<string, TickRow>();
  let cells = 0;

  return {
    note(node, field, prev, next, now): void {
      const id = node.id;
      if (id === undefined || !isNumber(prev) || !isNumber(next) || prev === next) return;
      let row = rows.get(id);
      if (row === undefined) {
        row = { node, fields: new Map() };
        rows.set(id, row);
      }
      if (!row.fields.has(field)) cells += 1;
      row.fields.set(field, { dir: next > prev ? 'up' : 'down', prev, until: now + options.holdMs });
    },

    direction(rowId, field, now = options.now()): TickDirection | null {
      if (rowId === undefined) return null;
      const entry = rows.get(rowId)?.fields.get(field);
      if (entry === undefined || entry.until <= now) return null;
      return entry.dir;
    },

    previous(rowId, field): number | undefined {
      return rows.get(rowId)?.fields.get(field)?.prev;
    },

    expire(now): ExpiredTicks[] {
      const out: ExpiredTicks[] = [];
      for (const [id, row] of rows) {
        const gone: string[] = [];
        for (const [field, entry] of row.fields) {
          if (entry.until <= now) gone.push(field);
        }
        if (gone.length === 0) continue;
        for (const field of gone) row.fields.delete(field);
        cells -= gone.length;
        out.push({ node: row.node, fields: gone });
        if (row.fields.size === 0) rows.delete(id);
      }
      return out;
    },

    clear(): void {
      rows.clear();
      cells = 0;
    },

    get size(): number {
      return cells;
    },
  };
}
