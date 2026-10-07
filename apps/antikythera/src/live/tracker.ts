import type { Order, OrderField, Row, ServerMsg } from '@apeiron/logos';
import type { ChangeSet } from '../query/changeset.js';
import type { TrackedBlock } from '../query/engine.js';
import type { View, ViewChanges } from '../query/view.js';
import type { ColumnarStore } from '../store/columnar-store.js';

export type DeltaMsg = Extract<ServerMsg, { t: 'delta' }>;

type Block = {
  key: string;
  routeKey: string;
  route: string[];
  startRow: number;
  kind: 'leaf' | 'group';
  /** Leaf rows (row indexes) or group labels this block holds. A set of what is tracked, not a position map. */
  rows: number[];
  labels: string[];
};

/** Changes waiting to be sent to one client. Values are read from the store when the delta is built, so a held-back client gets the latest. */
type Pending = {
  updates: Map<string, { route: string[]; rows: Map<number, Set<OrderField>> }>;
  groupUpdates: Map<string, { route: string[]; labels: Set<string> }>;
  adds: { route: string[]; rows: number[] }[];
  dirty: Map<string, string[]>;
  counts: Map<string, string[]>;
  newAbove: number;
};

const emptyPending = (): Pending => ({
  updates: new Map(),
  groupUpdates: new Map(),
  adds: [],
  dirty: new Map(),
  counts: new Map(),
  newAbove: 0,
});

/** Most rows tracked in a route's top block through `adds` (a scrolled-away client does not accumulate forever). */
const MAX_ADDED_ROWS = 500;

/**
 * What one client currently holds, and what changed under it. Mirrors the grid's block cache: each `getRows`
 * replaces the tracked entry for its block, the least recently requested blocks are dropped beyond
 * `maxBlocks`, and a client follows one view at a time. `collect` turns a tick's changes into pending deltas
 * (or keeps them pending while the client is held back by backpressure); `build` produces the delta message.
 */
export class ClientTracker {
  private currentView: View | null = null;
  private readonly blocks = new Map<string, Block>();
  private readonly rowRefs = new Map<number, { routeKey: string; route: string[]; n: number }>();
  private readonly labelRefs = new Map<string, Map<string, number>>();
  private readonly routes = new Map<string, { route: string[]; blocks: number }>();
  private pending: Pending = emptyPending();
  private sequence = 0;
  /** Start row of the last root-route block the client asked for (the top of what it is looking at). */
  rootTop = 0;

  constructor(private readonly maxBlocks: number) {}

  get view(): View | null {
    return this.currentView;
  }

  get trackedBlocks(): number {
    return this.blocks.size;
  }

  get trackedRows(): number {
    return this.rowRefs.size;
  }

  isTracking(routeKey: string): boolean {
    return this.routes.has(routeKey);
  }

  /** Whether any change is waiting to be sent. */
  get hasPending(): boolean {
    const p = this.pending;
    return p.updates.size > 0 || p.groupUpdates.size > 0 || p.adds.length > 0 || p.dirty.size > 0 || p.counts.size > 0 || p.newAbove > 0;
  }

  /** Records the block a `getRows` returned, replacing any earlier entry for the same block. */
  record(track: TrackedBlock): void {
    if (track.view !== this.currentView) this.follow(track.view);
    const key = `${track.routeKey}#${track.startRow}`;
    const existing = this.blocks.get(key);
    if (existing !== undefined) {
      this.unref(existing);
      this.blocks.delete(key);
    }
    const block: Block = {
      key,
      routeKey: track.routeKey,
      route: track.route,
      startRow: track.startRow,
      kind: track.kind,
      rows: track.rowIdx,
      labels: track.labels,
    };
    this.blocks.set(key, block);
    this.ref(block);
    const view = track.view;
    if (track.routeKey === '' && view.spec.groupCols.length === 0) this.rootTop = track.startRow;
    while (this.blocks.size > this.maxBlocks) {
      const oldest = this.blocks.keys().next().value as string;
      this.unref(this.blocks.get(oldest) as Block);
      this.blocks.delete(oldest);
    }
  }

  /** Forgets everything (a new `hello`, or the connection closing). */
  reset(): void {
    this.follow(null);
  }

  dispose(): void {
    this.follow(null);
  }

  /** Drops tracked blocks of the given routes and everything beneath them. */
  private dropRoute(routeKey: string): void {
    for (const [key, block] of [...this.blocks]) {
      if (block.routeKey === routeKey || block.routeKey.startsWith(`${routeKey}\u0000`)) {
        this.unref(block);
        this.blocks.delete(key);
      }
    }
    for (const key of [...this.pendingRouteKeys()]) {
      if (key === routeKey || key.startsWith(`${routeKey}\u0000`)) this.forgetPending(key);
    }
  }

  private *pendingRouteKeys(): Iterable<string> {
    yield* this.pending.updates.keys();
    yield* this.pending.groupUpdates.keys();
    yield* this.pending.dirty.keys();
    yield* this.pending.counts.keys();
  }

  private forgetPending(key: string): void {
    this.pending.updates.delete(key);
    this.pending.groupUpdates.delete(key);
    this.pending.dirty.delete(key);
    this.pending.counts.delete(key);
  }

  private follow(view: View | null): void {
    if (this.currentView !== null) this.currentView.refs--;
    this.currentView = view;
    if (view !== null) view.refs++;
    this.blocks.clear();
    this.rowRefs.clear();
    this.labelRefs.clear();
    this.routes.clear();
    this.pending = emptyPending();
    this.rootTop = 0;
  }

  private ref(block: Block): void {
    const r = this.routes.get(block.routeKey);
    if (r === undefined) this.routes.set(block.routeKey, { route: block.route, blocks: 1 });
    else r.blocks++;
    if (block.kind === 'leaf') {
      for (const row of block.rows) this.refRow(row, block);
    } else {
      let labels = this.labelRefs.get(block.routeKey);
      if (labels === undefined) {
        labels = new Map();
        this.labelRefs.set(block.routeKey, labels);
      }
      for (const l of block.labels) labels.set(l, (labels.get(l) ?? 0) + 1);
    }
  }

  private unref(block: Block): void {
    const r = this.routes.get(block.routeKey);
    if (r !== undefined && --r.blocks <= 0) this.routes.delete(block.routeKey);
    if (block.kind === 'leaf') {
      for (const row of block.rows) this.unrefRow(row);
    } else {
      const labels = this.labelRefs.get(block.routeKey);
      if (labels === undefined) return;
      for (const l of block.labels) {
        const n = (labels.get(l) ?? 0) - 1;
        if (n <= 0) labels.delete(l);
        else labels.set(l, n);
      }
      if (labels.size === 0) this.labelRefs.delete(block.routeKey);
    }
  }

  private refRow(row: number, block: Block): void {
    const ref = this.rowRefs.get(row);
    if (ref === undefined) this.rowRefs.set(row, { routeKey: block.routeKey, route: block.route, n: 1 });
    else ref.n++;
  }

  private unrefRow(row: number): void {
    const ref = this.rowRefs.get(row);
    if (ref !== undefined && --ref.n <= 0) this.rowRefs.delete(row);
  }

  /** Newly added rows join the top block of their route, so later changes to them are sent as updates. */
  private trackAdded(routeKey: string, rows: number[]): void {
    const block = this.blocks.get(`${routeKey}#0`);
    if (block === undefined) return;
    for (const row of rows) this.refRow(row, block);
    block.rows = [...rows, ...block.rows];
    while (block.rows.length > MAX_ADDED_ROWS) this.unrefRow(block.rows.pop() as number);
  }

  /**
   * Folds one tick into this client's pending changes: `updates` for tracked rows that changed, group-row
   * updates for tracked groups whose aggregates changed, `adds` for new orders on top of a `createdAt desc`
   * view, dirty routes for any other structural change under a tracked route, and per-route counts.
   */
  collect(changes: ViewChanges | undefined, cs: ChangeSet): void {
    const view = this.currentView;
    if (view === null) return;
    const p = this.pending;

    const note = (row: number, routeKey: string, route: string[]): void => {
      const e = cs.entries.get(row);
      if (e === undefined || e.isNew || e.fields.size === 0) return;
      let r = p.updates.get(routeKey);
      if (r === undefined) {
        r = { route, rows: new Map() };
        p.updates.set(routeKey, r);
      }
      let fields = r.rows.get(row);
      if (fields === undefined) {
        fields = new Set();
        r.rows.set(row, fields);
      }
      for (const f of e.fields) fields.add(f);
    };
    if (this.rowRefs.size <= cs.size) {
      for (const [row, ref] of this.rowRefs) note(row, ref.routeKey, ref.route);
    } else {
      for (const row of cs.entries.keys()) {
        const ref = this.rowRefs.get(row);
        if (ref !== undefined) note(row, ref.routeKey, ref.route);
      }
    }
    if (changes === undefined) return;

    if (changes.rebuilt) {
      for (const [key, r] of this.routes) p.dirty.set(key, r.route);
      return;
    }
    for (const removed of changes.removedRoutes) this.dropRoute(removed);

    const groupDepth = view.spec.groupCols.length;
    for (const [key, rc] of changes.routes) {
      const tracked = this.routes.get(key);
      if (tracked === undefined) continue;
      if (rc.countChanged) p.counts.set(key, rc.route);
      if (rc.route.length < groupDepth) {
        if (rc.orderChanged) {
          p.dirty.set(key, rc.route);
          continue;
        }
        const held = this.labelRefs.get(key);
        if (held === undefined) continue;
        const labels = [...rc.labels].filter((l) => held.has(l));
        if (labels.length === 0) continue;
        let g = p.groupUpdates.get(key);
        if (g === undefined) {
          g = { route: rc.route, labels: new Set() };
          p.groupUpdates.set(key, g);
        }
        for (const l of labels) g.labels.add(l);
        continue;
      }
      if (rc.structural) p.dirty.set(key, rc.route);
      if (rc.inserts.length > 0) this.collectInserts(key, rc, view, p);
    }
  }

  private collectInserts(key: string, rc: ViewChanges['routes'] extends Map<string, infer R> ? R : never, view: View, p: Pending): void {
    const byPos = [...rc.inserts].sort((a, b) => a.pos - b.pos);
    const onTop = byPos.every((ins, i) => ins.pos === i);
    if (view.leafIsCreatedAtDesc && onTop && this.blocks.has(`${key}#0`)) {
      const rows = byPos.map((i) => i.row);
      p.adds.push({ route: rc.route, rows });
      this.trackAdded(key, rows);
    } else {
      p.dirty.set(key, rc.route);
    }
    if (key === '' && view.spec.groupCols.length === 0) {
      p.newAbove += rc.inserts.filter((i) => i.pos < this.rootTop).length;
    }
  }

  /**
   * Builds the delta for everything pending, reading current values from the store and the view, and clears
   * it. Returns null when there is nothing to send. Clients apply `adds` before `updates`.
   */
  build(store: ColumnarStore, now: number): DeltaMsg | null {
    const view = this.currentView;
    if (view === null || !this.hasPending) return null;
    const p = this.pending;
    this.pending = emptyPending();

    const updates: DeltaMsg['updates'] = [];
    for (const { route, rows } of p.updates.values()) {
      const out: DeltaMsg['updates'][number]['rows'] = [];
      for (const [row, fields] of rows) {
        const partial: Record<string, unknown> = { orderId: store.stringColumn('orderId')[row] as string };
        for (const f of fields) partial[f] = store.valueAt(store.column(f), row);
        out.push(partial as DeltaMsg['updates'][number]['rows'][number]);
      }
      if (out.length > 0) updates.push({ route, rows: out });
    }
    const groupUpdates: DeltaMsg['groupUpdates'] = [];
    for (const { route, labels } of p.groupUpdates.values()) {
      const rows: Row[] = view.groupRows(route, labels);
      if (rows.length > 0) groupUpdates.push({ route, rows });
    }
    const adds: DeltaMsg['adds'] = p.adds.map((a) => ({
      route: a.route,
      addIndex: 0,
      rows: a.rows.map((row) => store.orderAt(row) as Order),
    }));
    const rowCounts: DeltaMsg['rowCounts'] = [];
    for (const route of p.counts.values()) {
      const rowCount = view.routeCount(route);
      if (rowCount !== null) rowCounts.push({ route, rowCount });
    }
    const dirtyRoutes = [...p.dirty.values()];
    if (
      updates.length === 0 &&
      groupUpdates.length === 0 &&
      adds.length === 0 &&
      dirtyRoutes.length === 0 &&
      rowCounts.length === 0 &&
      p.newAbove === 0
    ) {
      return null;
    }
    return {
      t: 'delta',
      seq: ++this.sequence,
      serverTs: now,
      updates,
      groupUpdates,
      adds,
      dirtyRoutes,
      rowCounts,
      newAbove: p.newAbove,
    };
  }
}
