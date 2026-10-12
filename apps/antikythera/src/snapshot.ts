import {
  BUCKETS,
  PROJECTION_KEY,
  parseProjectionMarker,
  type Bus,
  type KvEntry,
  type KvWatch,
  type Order,
  type OrderField,
} from '@apeiron/logos';
import { LagMonitor, withLagReport, type LagSnapshot } from './lag.js';
import { forceGc, memorySnapshot, peakRssMb, type MemorySnapshot } from './memory.js';
import { readRecord } from './records.js';
import type { ColumnarStore, StoreMemory } from './store/columnar-store.js';

export type LoadReport = {
  rows: number;
  /** Total snapshot time: waiting for the projection, the initial values, the sort and the string ranks. */
  loadMs: number;
  /** The part of `loadMs` spent building string sort ranks. */
  rankMs: number;
  /** The part of `loadMs` spent putting the rows into ascending order. */
  sortMs: number;
  /** RSS right after the initial values were read, before sorting and building ranks. */
  streamedRssMb: number;
  /** Peak RSS of the process so far (includes the load transient). */
  peakRssMb: number;
  /** Heap and RSS right after loading, before a forced GC. */
  before: MemorySnapshot;
  /** After a forced full GC: what the store actually retains. Null when GC cannot be forced. */
  afterGc: MemorySnapshot | null;
  /** Event-loop lag while loading. */
  lag: LagSnapshot;
  store: Pick<StoreMemory, 'typedUsedBytes' | 'typedReservedBytes' | 'estimatedStringHeapBytes'>;
  /** Records the projection marker promised. */
  expected: number;
  /** Initial entries that were deletes or unreadable. */
  skipped: number;
};

export type SnapshotOptions = {
  bus: Bus;
  store: ColumnarStore;
  monitor?: LagMonitor;
  log?: (message: string, fields: Record<string, unknown>) => void;
  /** Wait between looks at the projection marker (default 500 ms). */
  markerPollMs?: number;
  /** Wait before starting over after an incomplete load (default 5 s). */
  retryMs?: number;
  /** Rows appended per call (default 2,000). */
  batchSize?: number;
};

/** The snapshot, and the still-open watch from which live updates continue. */
export type Snapshot = {
  report: LoadReport;
  /** Positioned just after the initial values; keeps delivering changes until `watch.close()`. */
  entries: AsyncIterator<KvEntry>;
  watch: KvWatch;
  /** The highest revision among the initial values. */
  revision: number;
};

/** Free-text string columns other than `orderId` (which sorts by row order). */
const RANKED_FIELDS: readonly OrderField[] = ['parentOrderId', 'clientOrderId', 'strategyParams'];

export const DEFAULT_BATCH = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class IncompleteSnapshot extends Error {}

/**
 * Loads the latest state of every order from the `ORDER_STATE` bucket into the store, and returns the watch to
 * continue with. Waits until the order service says its projection is complete (`ORDER_STATE_META`), then reads the
 * initial values straight into the columnar store, 2,000 rows at a time. The initial phase ends at the entry with
 * nothing pending behind it (`delta === 0`). If fewer orders arrive than the marker promised, or the bucket is empty,
 * the store is cleared and the whole load starts again, so an empty or half-built bucket never serves a client.
 * Finishes by putting the rows into ascending `orderId` order and building the string ranks.
 */
export async function loadSnapshot(options: SnapshotOptions): Promise<Snapshot> {
  const monitor = options.monitor ?? new LagMonitor();
  const ownsMonitor = options.monitor === undefined;
  if (ownsMonitor) monitor.start();
  const start = performance.now();
  try {
    for (;;) {
      try {
        const attempt = await withLagReport(monitor, () => attemptSnapshot(options, start));
        return { ...attempt.result, report: { ...attempt.result.report, lag: attempt.lag } };
      } catch (error) {
        if (!(error instanceof IncompleteSnapshot)) throw error;
        options.log?.('snapshot incomplete, starting again', { reason: error.message });
        options.store.clear();
        await sleep(options.retryMs ?? 5_000);
      }
    }
  } finally {
    if (ownsMonitor) monitor.stop();
  }
}

async function waitForProjection(options: SnapshotOptions): Promise<number> {
  const meta = options.bus.kv(BUCKETS.orderStateMeta);
  let logged = false;
  for (;;) {
    const entry: KvEntry | null = await meta.get(PROJECTION_KEY).catch(() => null);
    const parsed = entry === null ? null : parseProjectionMarker(entry.value);
    if (parsed !== null && parsed.ok && parsed.value.ready) return parsed.value.count;
    if (!logged) options.log?.('waiting for the order service to finish the projection', {});
    logged = true;
    await sleep(options.markerPollMs ?? 500);
  }
}

async function attemptSnapshot(options: SnapshotOptions, start: number): Promise<Omit<Snapshot, 'report'> & { report: Omit<LoadReport, 'lag'> }> {
  const { bus, store } = options;
  const expected = await waitForProjection(options);
  const state = bus.kv(BUCKETS.orderState);
  const values = (await state.status()).values;
  if (values === 0) throw new IncompleteSnapshot('the projection is marked ready but the bucket is empty');

  const watch = await state.watch();
  const iterator = watch[Symbol.asyncIterator]();
  const batchSize = options.batchSize ?? DEFAULT_BATCH;
  let pending: Order[] = [];
  let pendingV: number[] = [];
  const pendingAt = new Map<string, number>();
  let skipped = 0;
  let revision = 0;
  let lastLog = performance.now();

  const flushPending = (): void => {
    if (pending.length === 0) return;
    store.appendBatch(pending, pendingV);
    pending = [];
    pendingV = [];
    pendingAt.clear();
  };

  try {
    for (;;) {
      const step = await iterator.next();
      if (step.done === true) throw new IncompleteSnapshot('the watch ended before the initial values were complete');
      const entry = step.value;
      revision = Math.max(revision, entry.revision);
      const record = entry.op === 'PUT' ? readRecord(entry.value) : null;
      if (record === null) skipped++;
      else {
        const id = record.order.orderId;
        const inPending = pendingAt.get(id);
        const row = store.rowIndexOf(id);
        if (inPending !== undefined) {
          // The same order twice in the initial values: an update arrived while loading. Keep the newer one.
          if (record.v > (pendingV[inPending] as number)) {
            pending[inPending] = record.order;
            pendingV[inPending] = record.v;
          }
        } else if (row !== undefined) {
          if (record.v > store.versionAt(row)) {
            store.updateRow(row, record.order);
            store.setVersion(row, record.v);
          }
        } else {
          pendingAt.set(id, pending.length);
          pending.push(record.order);
          pendingV.push(record.v);
          if (pending.length >= batchSize) {
            flushPending();
            await yieldToLoop();
          }
        }
      }
      if (entry.delta === 0) break;
      const now = performance.now();
      if (now - lastLog > 5_000) {
        lastLog = now;
        options.log?.('loading', { rows: store.size + pending.length, expected, elapsedMs: Math.round(now - start) });
      }
    }
    flushPending();
    if (store.size < expected) throw new IncompleteSnapshot(`received ${store.size} orders but the projection marker promised ${expected}`);
  } catch (error) {
    await watch.close();
    throw error;
  }

  const streamedRssMb = memorySnapshot().rssMb;
  const sortStart = performance.now();
  store.sortByOrderId();
  await yieldToLoop();
  const sortMs = Math.round(performance.now() - sortStart);
  const rankStart = performance.now();
  for (const field of RANKED_FIELDS) {
    store.stringRank(field);
    await yieldToLoop();
  }
  const rankMs = Math.round(performance.now() - rankStart);

  const loadMs = Math.round(performance.now() - start);
  const before = memorySnapshot();
  const afterGc = forceGc() ? memorySnapshot() : null;
  const mem = store.memory();
  return {
    entries: iterator,
    watch,
    revision,
    report: {
      rows: store.size,
      loadMs,
      rankMs,
      sortMs,
      streamedRssMb,
      peakRssMb: peakRssMb(),
      before,
      afterGc,
      store: { typedUsedBytes: mem.typedUsedBytes, typedReservedBytes: mem.typedReservedBytes, estimatedStringHeapBytes: mem.estimatedStringHeapBytes },
      expected,
      skipped,
    },
  };
}
