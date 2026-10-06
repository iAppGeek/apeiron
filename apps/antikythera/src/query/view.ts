import type { Row } from '@apeiron/logos';
import type { ColumnarStore } from '../store/columnar-store.js';
import { buildGroupLevel, type GroupLevel, type GroupSortSpec } from './group.js';
import { DEFAULT_SORT, sortRows, type SortKey } from './sort.js';
import type { NormalizedQuery } from './request.js';

/** One route (a path of group keys) inside a view: its rows, its group level and its sorted leaves. */
type RouteNode = {
  /** Ascending row indexes under this route. */
  rows: Uint32Array;
  group?: GroupLevel;
  sortedLeaf?: Uint32Array;
};

export type Block = { rows: Row[]; rowCount: number };

/** The parts of a query that define a view (everything except the block range and group keys). */
export type ViewSpec = Pick<NormalizedQuery, 'sort' | 'groupCols' | 'valueCols'>;

/**
 * A filtered view of the store. Holds the filtered row indexes (ascending), then builds, lazily and per
 * requested route, the group levels and the sorted leaf index. Views are shared by every client with
 * the same query, so nothing here is per-client state.
 */
export class View {
  /** Index memory owned by this view, in bytes (shared "all rows" arrays are not counted). */
  bytes: number;
  private readonly root: RouteNode;
  private readonly routes = new Map<string, RouteNode>();
  private readonly leafKeys: SortKey[];

  constructor(
    private readonly store: ColumnarStore,
    private readonly spec: ViewSpec,
    filtered: Uint32Array,
    ownsFiltered: boolean,
  ) {
    this.root = { rows: filtered };
    this.bytes = ownsFiltered ? filtered.byteLength : 0;
    const keys = spec.sort.flatMap((s): SortKey[] => (s.field === null ? [] : [{ field: s.field, desc: s.desc }]));
    this.leafKeys = keys.length > 0 ? keys : [...DEFAULT_SORT];
  }

  /** Rows that pass the view's filter, before any grouping. */
  get filteredCount(): number {
    return this.root.rows.length;
  }

  /** Returns rows `[startRow, endRow)` of the route named by `groupKeys`, plus the route's exact row count. */
  getBlock(groupKeys: readonly string[], startRow: number, endRow: number): Block {
    const node = this.resolve(groupKeys);
    if (node === null) return { rows: [], rowCount: 0 };
    const depth = groupKeys.length;
    if (depth < this.spec.groupCols.length) {
      const level = this.groupLevel(node, depth);
      return { rows: this.groupRows(level, startRow, endRow), rowCount: level.labels.length };
    }
    if (node.sortedLeaf === undefined) {
      node.sortedLeaf = sortRows(this.store, node.rows, this.leafKeys);
      this.bytes += node.sortedLeaf.byteLength;
    }
    return { rows: this.store.materialize(node.sortedLeaf, startRow, endRow), rowCount: node.sortedLeaf.length };
  }

  private resolve(groupKeys: readonly string[]): RouteNode | null {
    let node = this.root;
    let routeKey = '';
    for (let d = 0; d < groupKeys.length; d++) {
      const key = groupKeys[d] as string;
      routeKey += `${routeKey === '' ? '' : '\u0000'}${key.length}:${key}`;
      const cached = this.routes.get(routeKey);
      if (cached !== undefined) {
        node = cached;
        continue;
      }
      const level = this.groupLevel(node, d);
      const g = level.indexByLabel.get(key);
      if (g === undefined) return null;
      const child: RouteNode = {
        rows: level.part.subarray(level.offsets[g] as number, level.offsets[g + 1] as number),
      };
      this.routes.set(routeKey, child);
      node = child;
    }
    return node;
  }

  private groupLevel(node: RouteNode, depth: number): GroupLevel {
    if (node.group === undefined) {
      const field = this.spec.groupCols[depth] as NonNullable<ViewSpec['groupCols'][number]>;
      node.group = buildGroupLevel(this.store, node.rows, field, this.spec.valueCols, this.groupSortSpec(depth));
      this.bytes += node.group.bytes;
    }
    return node.group;
  }

  /** Sort entries that name this level's group column (or the auto column) sort by key; value-column entries by aggregate. */
  private groupSortSpec(depth: number): GroupSortSpec[] {
    const groupField = this.spec.groupCols[depth];
    const out: GroupSortSpec[] = [];
    for (const s of this.spec.sort) {
      if (s.field === null || s.field === groupField) {
        out.push({ kind: 'key', desc: s.desc });
        continue;
      }
      const index = this.spec.valueCols.findIndex((v) => v.id === s.colId);
      if (index >= 0) out.push({ kind: 'agg', index, desc: s.desc });
    }
    return out;
  }

  private groupRows(level: GroupLevel, startRow: number, endRow: number): Row[] {
    const rows: Row[] = [];
    const end = Math.min(endRow, level.labels.length);
    for (let g = Math.max(0, startRow); g < end; g++) {
      const row: Row = { [level.field]: level.labels[g] as string, childCount: level.counts[g] as number };
      for (let j = 0; j < this.spec.valueCols.length; j++) {
        row[(this.spec.valueCols[j] as { field: string }).field] = (level.aggs[j] as (number | null)[])[g] as
          | number
          | null;
      }
      rows.push(row);
    }
    return rows;
  }
}
