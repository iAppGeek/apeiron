import type { OrderField } from '@apeiron/logos';
import type { OrderRepository } from '@apeiron/mnemosyne';
import type { ColumnarStore, StoreMemory } from './store/columnar-store.js';
import { LagMonitor, withLagReport, type LagSnapshot } from './lag.js';
import { forceGc, memorySnapshot, peakRssMb, type MemorySnapshot } from './memory.js';

export type LoadReport = {
  rows: number;
  /** Total load time: streaming the repository plus building the string sort ranks. */
  loadMs: number;
  /** The part of `loadMs` spent building string sort ranks. */
  rankMs: number;
  /** RSS right after the repository stream ended, before building ranks. */
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
};

export type LoadOptions = {
  batchSize?: number;
  monitor?: LagMonitor;
  log?: (message: string, fields: Record<string, unknown>) => void;
};

/** Free-text string columns other than `orderId` (which sorts by row order). */
const RANKED_FIELDS: readonly OrderField[] = ['parentOrderId', 'clientOrderId', 'strategyParams'];

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Streams the repository into the store in batches (never holding the full set of `Order` objects),
 * yielding to the event loop between batches so HTTP and WebSocket traffic keeps flowing.
 */
export async function loadStore(
  repo: OrderRepository,
  store: ColumnarStore,
  options: LoadOptions = {},
): Promise<LoadReport> {
  const monitor = options.monitor ?? new LagMonitor();
  const ownsMonitor = options.monitor === undefined;
  if (ownsMonitor) monitor.start();
  const start = performance.now();
  let rankMs = 0;
  let streamedRssMb = 0;
  try {
    const { lag } = await withLagReport(monitor, async () => {
      let lastLog = start;
      for await (const batch of repo.loadAll(options.batchSize ?? 10_000)) {
        store.appendBatch(batch);
        const now = performance.now();
        if (now - lastLog > 5_000) {
          lastLog = now;
          options.log?.('loading', { rows: store.size, elapsedMs: Math.round(now - start) });
        }
        await yieldToLoop();
      }
      // Build the string sort ranks now so the first sort by a text column does not stall a client.
      streamedRssMb = memorySnapshot().rssMb;
      const rankStart = performance.now();
      for (const field of RANKED_FIELDS) {
        store.stringRank(field);
        await yieldToLoop();
      }
      rankMs = Math.round(performance.now() - rankStart);
    });
    const loadMs = Math.round(performance.now() - start);
    const before = memorySnapshot();
    const afterGc = forceGc() ? memorySnapshot() : null;
    const mem = store.memory();
    return {
      rows: store.size,
      loadMs,
      rankMs,
      streamedRssMb,
      peakRssMb: peakRssMb(),
      before,
      afterGc,
      lag,
      store: {
        typedUsedBytes: mem.typedUsedBytes,
        typedReservedBytes: mem.typedReservedBytes,
        estimatedStringHeapBytes: mem.estimatedStringHeapBytes,
      },
    };
  } finally {
    if (ownsMonitor) monitor.stop();
  }
}
