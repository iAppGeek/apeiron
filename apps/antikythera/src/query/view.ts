import { COLUMN_BY_FIELD, type OrderField, type Row } from '@apeiron/logos';
import type { ColumnarStore } from '../store/columnar-store.js';
import { maskOf, type ChangeSet, type FieldMask } from './changeset.js';
import { compileFilter, filterRows, type Predicate } from './filter.js';
import {
  buildGroupLevel,
  finalizeAgg,
  groupOrderComparator,
  labelOfValue,
  BLANK_KEY,
  type GroupSortSpec,
} from './group.js';
import type { NormalizedQuery } from './request.js';
import { RowBuf } from './row-buf.js';
import { DEFAULT_SORT, makeComparator, sortRows, type SortKey } from './sort.js';

const DAY_MS = 86_400_000;

/** Above this many structural changes in one tick a view is rebuilt instead of patched (Appendix D). */
export const STRUCTURAL_REBUILD_THRESHOLD = 5_000;

/** The parts of a query that define a view (everything except the block range and group keys). */
export type ViewSpec = Pick<NormalizedQuery, 'sort' | 'groupCols' | 'valueCols' | 'filter' | 'traderId'>;

/** One group (or the leaf set) under a route: its member rows, plus whatever has been built lazily. */
type RouteNode = {
  /** Ascending row indexes of the route's members. For a group's child this is the group's own buffer. */
  rows: RowBuf;
  group?: GroupState;
  /** Leaf level only: the members in sort order. */
  sorted?: RowBuf;
};

type Bucket = {
  label: string;
  rows: RowBuf;
  /** Running sums per value column j: `[3j]` sum, `[3j+1]` count of non-null values, `[3j+2]` sum of weights. */
  acc: Float64Array;
  child: RouteNode | undefined;
};

type GroupState = {
  field: OrderField;
  buckets: Map<string, Bucket>;
  /** Buckets in display order. */
  order: Bucket[];
};

/** A row's journey through one node during a tick. */
type Entry = {
  row: number;
  isNew: boolean;
  /** A member of this node before the tick / after the tick. */
  oldIn: boolean;
  newIn: boolean;
  /** A value column (or its weight) changed. */
  agg: boolean;
};

export type Block = {
  rows: Row[];
  rowCount: number;
  kind: 'leaf' | 'group';
  /** Row indexes of the returned leaf rows. */
  rowIdx: number[];
  /** Group keys of the returned group rows. */
  labels: string[];
};

export type RouteChange = {
  route: string[];
  /** Leaf route: rows left, entered or moved (appended rows are reported in `inserts`). */
  structural: boolean;
  /** Group route: existing groups whose count or aggregates changed. */
  labels: Set<string>;
  /** Group route: groups were created, removed or reordered. */
  orderChanged: boolean;
  countChanged: boolean;
  /** The route's row count after the tick. */
  rowCount: number;
  /** Leaf route: newly appended rows and the position each landed at. */
  inserts: { row: number; pos: number }[];
};

export type ViewChanges = {
  view: View;
  /** The view was rebuilt from scratch; every route it tracked is stale. */
  rebuilt: boolean;
  routes: Map<string, RouteChange>;
  /** Routes whose group was removed. */
  removedRoutes: string[];
};

/** The patch could not be applied because the view disagrees with the store; the view must be rebuilt. */
export class ViewInconsistent extends Error {}

/** Stable key of a route (a path of group keys), unambiguous for any characters in the keys. */
export function routeKeyOf(route: readonly string[]): string {
  let out = '';
  for (let i = 0; i < route.length; i++) {
    const key = route[i] as string;
    out += `${i === 0 ? '' : '\u0000'}${key.length}:${key}`;
  }
  return out;
}

const byNumber = (a: number, b: number): number => a - b;

/**
 * A filtered, sorted and grouped view of the store, shared by every client with the same query. The filtered
 * row set is built on creation; group levels and sorted leaf sets are built lazily per requested route.
 * After that the view is never rebuilt on a store change: `applyChanges` patches it from the tick's
 * ChangeSet (rows leaving, entering and moving, group buckets appearing and disappearing, aggregates
 * adjusted from the previous values). The property tests hold it equal to a fresh build.
 */
export class View {
  /** Index memory owned by this view, in bytes (the shared identity array is not counted). */
  bytes = 0;
  /** Clients that track blocks of this view; a view with subscribers is never evicted. */
  refs = 0;
  lastUsed = Date.now();
  private root!: RouteNode;
  private ownsRoot = true;
  private preds: Predicate[] = [];
  private predsLayout = -1;
  private builtAscending = true;
  private readonly leafKeys: SortKey[];
  private readonly structMask: FieldMask;
  private readonly aggMask: FieldMask;
  private readonly sortMask: FieldMask;
  private readonly filterFields: OrderField[];
  private readonly groupFields: readonly OrderField[];

  constructor(
    private readonly store: ColumnarStore,
    readonly spec: ViewSpec,
    /** Shared ascending 0..n-1 array used as the root when nothing filters rows (not mutated by the view). */
    private readonly identity: RowBuf | null = null,
    readonly key: string = '',
    private readonly rebuildThreshold: number = STRUCTURAL_REBUILD_THRESHOLD,
  ) {
    const keys = spec.sort.flatMap((s): SortKey[] => (s.field === null ? [] : [{ field: s.field, desc: s.desc }]));
    this.leafKeys = keys.length > 0 ? keys : [...DEFAULT_SORT];
    this.groupFields = spec.groupCols;
    this.filterFields = Object.keys(spec.filter).filter((f) => COLUMN_BY_FIELD.has(f as OrderField)) as OrderField[];
    if (spec.traderId !== 'ALL') this.filterFields.push('traderId');
    const grouped = spec.groupCols.length > 0;
    const aggFields: OrderField[] = spec.valueCols.map((v) => v.field);
    if (spec.valueCols.some((v) => v.agg === 'wavg')) aggFields.push('notionalUsd');
    this.aggMask = grouped ? maskOf(aggFields) : { lo: 0, hi: 0 };
    this.sortMask = maskOf(this.leafKeys.map((k) => k.field));
    const structural = new Set<OrderField>([...this.filterFields, ...this.groupFields, ...this.leafKeys.map((k) => k.field)]);
    this.structMask = maskOf(structural);
    this.build();
  }

  /** True when leaf rows are ordered by exactly `createdAt desc` (then new orders always land at position 0). */
  get leafIsCreatedAtDesc(): boolean {
    return this.leafKeys.length === 1 && this.leafKeys[0]?.field === 'createdAt' && this.leafKeys[0].desc;
  }

  /** Rows that pass the view's filter, before any grouping. */
  get filteredCount(): number {
    return this.root.rows.len;
  }

  /** Number of rows in a route's block list (groups at a group level, rows at the leaf level), or null if unknown. */
  routeCount(route: readonly string[]): number | null {
    const node = this.resolve(route);
    if (node === null) return null;
    if (route.length < this.spec.groupCols.length) return this.groupState(node, route.length).order.length;
    return this.leaf(node).len;
  }

  /** Returns rows `[startRow, endRow)` of the route named by `groupKeys`, plus the route's exact row count. */
  getBlock(groupKeys: readonly string[], startRow: number, endRow: number): Block {
    this.lastUsed = Date.now();
    const node = this.resolve(groupKeys);
    if (node === null) return { rows: [], rowCount: 0, kind: 'leaf', rowIdx: [], labels: [] };
    const depth = groupKeys.length;
    if (depth < this.spec.groupCols.length) {
      const st = this.groupState(node, depth);
      const rows: Row[] = [];
      const labels: string[] = [];
      const end = Math.min(endRow, st.order.length);
      for (let g = Math.max(0, startRow); g < end; g++) {
        const b = st.order[g] as Bucket;
        rows.push(this.groupRow(st.field, b));
        labels.push(b.label);
      }
      return { rows, rowCount: st.order.length, kind: 'group', rowIdx: [], labels };
    }
    const sorted = this.leaf(node);
    const end = Math.min(endRow, sorted.len);
    const rowIdx: number[] = [];
    for (let i = Math.max(0, startRow); i < end; i++) rowIdx.push(sorted.at(i));
    return {
      rows: this.store.materialize(rowIdx, 0, rowIdx.length),
      rowCount: sorted.len,
      kind: 'leaf',
      rowIdx,
      labels: [],
    };
  }

  /** Current group rows for the given keys of one group-level route (keys that no longer exist are skipped). */
  groupRows(route: readonly string[], labels: Iterable<string>): Row[] {
    const node = this.resolve(route);
    if (node === null || route.length >= this.spec.groupCols.length) return [];
    const st = this.groupState(node, route.length);
    const out: Row[] = [];
    for (const label of labels) {
      const b = st.buckets.get(label);
      if (b !== undefined) out.push(this.groupRow(st.field, b));
    }
    return out;
  }

  /** Discards everything and rebuilds from the store's current contents. */
  rebuild(): void {
    this.build();
  }

  /**
   * Patches the view for one tick. Rows are classified against the view's filter, sort and group fields:
   * only those that can change membership, position or an aggregate are touched. With more than 5,000
   * structural changes the view is rebuilt instead.
   */
  applyChanges(cs: ChangeSet, grown: ReadonlySet<OrderField>): ViewChanges {
    const changes: ViewChanges = { view: this, rebuilt: false, routes: new Map(), removedRoutes: [] };
    try {
      this.patch(cs, grown, changes);
    } catch (error) {
      if (!(error instanceof ViewInconsistent)) throw error;
      this.build();
      changes.rebuilt = true;
      changes.routes.clear();
      changes.removedRoutes = [];
      this.rebuiltAfterInconsistency++;
    }
    this.bytes = this.measure();
    return changes;
  }

  /** Times a patch had to be abandoned for a rebuild because the view and store disagreed (should stay 0). */
  rebuiltAfterInconsistency = 0;

  // ---------------------------------------------------------------- build

  private build(): void {
    this.compilePreds();
    this.builtAscending = this.store.idsAscending;
    const n = this.store.size;
    if (this.identity !== null && this.preds.length === 0) {
      this.root = { rows: this.identity };
      this.ownsRoot = false;
    } else {
      this.root = { rows: new RowBuf(filterRows(n, this.preds)) };
      this.ownsRoot = true;
    }
    this.bytes = this.measure();
  }

  private compilePreds(): void {
    this.preds = compileFilter(this.store, this.spec.filter, this.spec.traderId);
    this.predsLayout = this.store.layoutVersion;
  }

  private passes(row: number): boolean {
    for (let i = 0; i < this.preds.length; i++) if (!(this.preds[i] as Predicate)(row)) return false;
    return true;
  }

  // ---------------------------------------------------------------- lazy structure

  private resolve(route: readonly string[]): RouteNode | null {
    let node = this.root;
    for (let d = 0; d < route.length; d++) {
      const st = this.groupState(node, d);
      const bucket = st.buckets.get(route[d] as string);
      if (bucket === undefined) return null;
      bucket.child ??= { rows: bucket.rows };
      node = bucket.child;
    }
    return node;
  }

  private leaf(node: RouteNode): RowBuf {
    if (node.sorted === undefined) {
      node.sorted = new RowBuf(sortRows(this.store, node.rows.view, this.leafKeys));
      this.bytes = this.measure();
    }
    return node.sorted;
  }

  private groupState(node: RouteNode, depth: number): GroupState {
    if (node.group !== undefined) return node.group;
    const field = this.spec.groupCols[depth] as OrderField;
    const level = buildGroupLevel(this.store, node.rows.view, field, this.spec.valueCols, this.groupSortSpec(depth));
    const nv = this.spec.valueCols.length;
    const buckets = new Map<string, Bucket>();
    const order: Bucket[] = [];
    for (let g = 0; g < level.labels.length; g++) {
      const acc = new Float64Array(3 * nv);
      for (let j = 0; j < nv; j++) {
        const a = level.accum[j] as (typeof level.accum)[number];
        acc[3 * j] = a.sum[g] as number;
        acc[3 * j + 1] = a.cnt[g] as number;
        acc[3 * j + 2] = a.wsum[g] as number;
      }
      const bucket: Bucket = {
        label: level.labels[g] as string,
        rows: new RowBuf(level.part.slice(level.offsets[g] as number, level.offsets[g + 1] as number)),
        acc,
        child: undefined,
      };
      buckets.set(bucket.label, bucket);
      order.push(bucket);
    }
    node.group = { field, buckets, order };
    this.bytes = this.measure();
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

  private aggOf(b: Bucket, j: number): number | null {
    const vc = this.spec.valueCols[j] as ViewSpec['valueCols'][number];
    return finalizeAgg(vc.agg, b.acc[3 * j] as number, b.acc[3 * j + 1] as number, b.acc[3 * j + 2] as number, b.rows.len);
  }

  private groupRow(field: OrderField, b: Bucket): Row {
    const row: Row = { [field]: b.label, childCount: b.rows.len };
    for (let j = 0; j < this.spec.valueCols.length; j++) {
      row[(this.spec.valueCols[j] as { field: string }).field] = this.aggOf(b, j);
    }
    return row;
  }

  private measure(): number {
    let total = this.ownsRoot ? this.root.rows.bytes : 0;
    const walk = (node: RouteNode, owned: boolean): void => {
      if (owned && node !== this.root) total += node.rows.bytes;
      if (node.sorted !== undefined) total += node.sorted.bytes;
      if (node.group !== undefined) {
        for (const b of node.group.buckets.values()) {
          total += 64 + b.acc.byteLength;
          if (b.child !== undefined) walk(b.child, false);
          total += b.rows.bytes;
        }
      }
    };
    walk(this.root, this.ownsRoot);
    return total;
  }

  // ---------------------------------------------------------------- incremental update

  private patch(cs: ChangeSet, grown: ReadonlySet<OrderField>, changes: ViewChanges): void {
    if (this.store.idsAscending !== this.builtAscending) {
      this.build();
      changes.rebuilt = true;
      return;
    }
    const dictGrewUnderFilter = this.filterFields.some((f) => grown.has(f));
    if (this.predsLayout !== this.store.layoutVersion || dictGrewUnderFilter) this.compilePreds();

    const entries: Entry[] = [];
    let structural = 0;
    const m = this.structMask;
    const a = this.aggMask;
    for (const e of cs.entries.values()) {
      const isStructural = e.isNew || (e.lo & m.lo) !== 0 || (e.hi & m.hi) !== 0;
      const isAgg = !e.isNew && ((e.lo & a.lo) !== 0 || (e.hi & a.hi) !== 0);
      if (!isStructural && !isAgg) continue;
      const oldIn = !e.isNew && (this.ownsRoot ? this.root.rows.contains(e.row) : true);
      const newIn = isStructural ? this.passes(e.row) : oldIn;
      if (!oldIn && !newIn) continue;
      if (isStructural) structural++;
      entries.push({ row: e.row, isNew: e.isNew, oldIn, newIn, agg: isAgg || e.isNew });
    }
    if (entries.length === 0) return;
    if (structural > this.rebuildThreshold) {
      this.build();
      changes.rebuilt = true;
      return;
    }

    if (this.ownsRoot) {
      const root = this.root.rows;
      const removals = entries.filter((e) => e.oldIn && !e.newIn).map((e) => e.row).sort(byNumber);
      root.removeAt(removals.map((r) => root.lowerBound(r)));
      const inserts = entries.filter((e) => !e.oldIn && e.newIn).map((e) => e.row).sort(byNumber);
      root.insertAt(inserts, inserts.map((r) => root.lowerBound(r)));
    }
    this.applyNode(this.root, 0, [], entries, cs, changes);
  }

  private applyNode(
    node: RouteNode,
    depth: number,
    route: string[],
    entries: Entry[],
    cs: ChangeSet,
    changes: ViewChanges,
  ): void {
    if (depth < this.spec.groupCols.length) {
      if (node.group !== undefined) this.applyGroup(node.group, depth, route, entries, cs, changes);
      return;
    }
    if (node.sorted !== undefined) this.applyLeaf(node, node.sorted, route, entries, cs, changes);
  }

  private applyLeaf(
    node: RouteNode,
    sorted: RowBuf,
    route: string[],
    entries: Entry[],
    cs: ChangeSet,
    changes: ViewChanges,
  ): void {
    const cmpNew = makeComparator(this.store, this.leafKeys);
    const cmpOld = makeComparator(this.store, this.leafKeys, cs.prevOf);
    const before = sorted.len;
    const s = this.sortMask;
    const removals: number[] = [];
    const inserts: Entry[] = [];
    for (const e of entries) {
      const ce = cs.entries.get(e.row);
      const moved = !e.isNew && ce !== undefined && ((ce.lo & s.lo) !== 0 || (ce.hi & s.hi) !== 0);
      if (e.oldIn && (!e.newIn || moved)) removals.push(e.row);
      if (e.newIn && (!e.oldIn || moved)) inserts.push(e);
    }
    if (removals.length === 0 && inserts.length === 0) return;

    const positions: number[] = [];
    for (const row of removals) {
      let lo = 0;
      let hi = sorted.len;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (cmpOld(sorted.at(mid), row) < 0) lo = mid + 1;
        else hi = mid;
      }
      if (lo >= sorted.len || sorted.at(lo) !== row) throw new ViewInconsistent(`row ${row} not found at its old position`);
      positions.push(lo);
    }
    positions.sort(byNumber);
    sorted.removeAt(positions);

    const newRows = new Set(inserts.filter((e) => e.isNew).map((e) => e.row));
    const items = inserts.map((e) => e.row).sort(cmpNew);
    const at = items.map((row) => {
      let lo = 0;
      let hi = sorted.len;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (cmpNew(sorted.at(mid), row) < 0) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    });
    sorted.insertAt(items, at);
    if (sorted.len !== node.rows.len) throw new ViewInconsistent('sorted set and member set differ in size');

    const change = this.routeChange(changes, route);
    change.structural ||= removals.length > 0 || inserts.some((e) => !e.isNew);
    change.countChanged ||= sorted.len !== before;
    change.rowCount = sorted.len;
    items.forEach((row, i) => {
      if (newRows.has(row)) change.inserts.push({ row, pos: (at[i] as number) + i });
    });
  }

  private applyGroup(
    st: GroupState,
    depth: number,
    route: string[],
    entries: Entry[],
    cs: ChangeSet,
    changes: ViewChanges,
  ): void {
    const { store } = this;
    const field = st.field;
    const valueCols = this.spec.valueCols;
    const nv = valueCols.length;
    const countBefore = st.order.length;
    const orderBefore = st.order;

    const valueOf = (row: number, f: OrderField, usePrev: boolean): number => {
      if (usePrev) {
        const ce = cs.entries.get(row);
        if (ce !== undefined && !ce.isNew && f in ce.prev) {
          const v = ce.prev[f] as number | null | undefined;
          return typeof v === 'number' ? v : Number.NaN;
        }
      }
      return store.numberColumn(f)[row] as number;
    };
    const labelOf = (row: number, usePrev: boolean): string => {
      if (usePrev) {
        const ce = cs.entries.get(row);
        if (ce !== undefined && !ce.isNew && field in ce.prev) return labelOfValue(field, ce.prev[field]);
      }
      return labelOfValue(field, store.valueAt(store.column(field), row));
    };
    const contribute = (b: Bucket, row: number, usePrev: boolean, sign: 1 | -1): void => {
      dirty.add(b);
      for (let j = 0; j < nv; j++) {
        const vc = valueCols[j] as (typeof valueCols)[number];
        if (vc.agg === 'count') continue;
        const v = valueOf(row, vc.field, usePrev);
        if (vc.agg === 'wavg') {
          const w = valueOf(row, 'notionalUsd', usePrev);
          if (v === v && w === w) {
            b.acc[3 * j] = (b.acc[3 * j] as number) + sign * w * v;
            b.acc[3 * j + 1] = (b.acc[3 * j + 1] as number) + sign;
            b.acc[3 * j + 2] = (b.acc[3 * j + 2] as number) + sign * w;
          }
        } else if (v === v) {
          b.acc[3 * j] = (b.acc[3 * j] as number) + sign * v;
          b.acc[3 * j + 1] = (b.acc[3 * j + 1] as number) + sign;
        }
      }
    };

    const created = new Set<Bucket>();
    const touched = new Set<Bucket>();
    /** Buckets whose row count or aggregates differ after the tick. */
    const dirty = new Set<Bucket>();
    const removeRows = new Map<Bucket, number[]>();
    const insertRows = new Map<Bucket, number[]>();
    const childEntries = new Map<Bucket, Entry[]>();
    const push = <T>(map: Map<Bucket, T[]>, b: Bucket, item: T): void => {
      const list = map.get(b);
      if (list === undefined) map.set(b, [item]);
      else list.push(item);
    };

    for (const e of entries) {
      let oldBucket: Bucket | undefined;
      let newBucket: Bucket | undefined;
      if (e.oldIn) {
        oldBucket = st.buckets.get(labelOf(e.row, true));
        if (oldBucket === undefined) throw new ViewInconsistent(`row ${e.row} has no group at its old key`);
      }
      if (e.newIn) {
        const label = labelOf(e.row, false);
        newBucket = st.buckets.get(label);
        if (newBucket === undefined) {
          newBucket = { label, rows: RowBuf.empty(), acc: new Float64Array(3 * nv), child: undefined };
          st.buckets.set(label, newBucket);
          created.add(newBucket);
        }
      }
      const same = oldBucket !== undefined && oldBucket === newBucket;
      if (oldBucket !== undefined && !same) {
        push(removeRows, oldBucket, e.row);
        contribute(oldBucket, e.row, true, -1);
      }
      if (newBucket !== undefined && !same) {
        push(insertRows, newBucket, e.row);
        contribute(newBucket, e.row, false, 1);
      }
      if (same && e.agg && oldBucket !== undefined) {
        contribute(oldBucket, e.row, true, -1);
        contribute(oldBucket, e.row, false, 1);
      }
      if (oldBucket !== undefined) {
        touched.add(oldBucket);
        if (oldBucket.child !== undefined) push(childEntries, oldBucket, { row: e.row, isNew: e.isNew, oldIn: true, newIn: same, agg: e.agg });
      }
      if (newBucket !== undefined) {
        touched.add(newBucket);
        if (!same && newBucket.child !== undefined) {
          push(childEntries, newBucket, { row: e.row, isNew: e.isNew, oldIn: false, newIn: true, agg: e.agg });
        }
      }
    }

    for (const [b, rows] of removeRows) {
      rows.sort(byNumber);
      dirty.add(b);
      b.rows.removeAt(rows.map((r) => b.rows.lowerBound(r)));
    }
    for (const [b, rows] of insertRows) {
      rows.sort(byNumber);
      dirty.add(b);
      b.rows.insertAt(rows, rows.map((r) => b.rows.lowerBound(r)));
    }

    const removed: Bucket[] = [];
    for (const b of touched) {
      if (b.rows.len === 0) {
        st.buckets.delete(b.label);
        removed.push(b);
        changes.removedRoutes.push(routeKeyOf([...route, b.label]));
      }
    }
    for (const [b, es] of childEntries) {
      if (b.rows.len === 0 || b.child === undefined) continue;
      this.applyNode(b.child, depth + 1, [...route, b.label], es, cs, changes);
    }

    const sortSpec = this.groupSortSpec(depth);
    const aggSorted = sortSpec.some((s) => s.kind === 'agg');
    if (created.size > 0 || removed.length > 0 || (aggSorted && dirty.size > 0)) {
      const enumCol = store.column(field);
      const rank = enumCol.kind === 'enum' ? enumCol.dict.rank : null;
      const keyOrder = (b: Bucket): number => {
        if (enumCol.kind === 'enum') return (rank as Uint16Array)[enumCol.dict.codeOf(b.label) as number] as number;
        return b.label === BLANK_KEY ? -1 : Date.parse(b.label) / DAY_MS;
      };
      const aggValue = (j: number, b: Bucket): number => this.aggOf(b, j) ?? Number.NEGATIVE_INFINITY;
      st.order = [...st.buckets.values()].sort(groupOrderComparator<Bucket>(sortSpec, keyOrder, aggValue));
    }
    const orderChanged =
      st.order.length !== orderBefore.length || st.order.some((b, i) => b !== orderBefore[i]);

    const labels = new Set<string>();
    for (const b of dirty) if (!created.has(b) && b.rows.len > 0) labels.add(b.label);
    const change = this.routeChange(changes, route);
    for (const l of labels) change.labels.add(l);
    change.orderChanged ||= orderChanged;
    change.countChanged ||= st.order.length !== countBefore;
    change.rowCount = st.order.length;
  }

  private routeChange(changes: ViewChanges, route: string[]): RouteChange {
    const key = routeKeyOf(route);
    let c = changes.routes.get(key);
    if (c === undefined) {
      c = { route, structural: false, labels: new Set(), orderChanged: false, countChanged: false, rowCount: 0, inserts: [] };
      changes.routes.set(key, c);
    }
    return c;
  }
}

