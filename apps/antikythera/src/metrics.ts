import type { CodecName } from '@apeiron/logos';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { ViewCacheStats } from './query/view-cache.js';

export type Direction = 'in' | 'out';
export type BackpressureEvent = 'soft_conflate' | 'slow_consumer';
export type IngestType = 'price' | 'order' | 'command';

/** What a client session reports. Every label has a small fixed set of values: never a client or order id. */
export type SessionMetrics = {
  message(direction: Direction, type: string, codec: CodecName, bytes: number): void;
  getRows(info: { ms: number; built: boolean; grouped: boolean }): void;
  delta(bytes: number): void;
  /** Seconds from the delta's earliest source event to the moment it was handed to the socket. */
  eventAgeAtSend(seconds: number): void;
  error(code: string): void;
  backpressure(event: BackpressureEvent): void;
};

/** What the live runtime and write-behind report. */
export type RuntimeMetrics = {
  flush(seconds: number): void;
  eventAge(seconds: number): void;
  ingest(type: IngestType, count?: number): void;
  writeBehind(info: { batchSize: number; seconds: number; ok: boolean }): void;
  command(outcome: string, seconds: number): void;
  /** What a flush did with the cached views. */
  views(stats: { patched: number; deferred: number; unsubscribed: number; pendingRebuild: number; stale: number }): void;
  /** A deferred view rebuild ran. */
  rebuild(seconds: number): void;
};

/** Where the scrape-time gauges read their values from. Each returns null while that part of the server is not up. */
export type MetricSources = {
  storeRows(): number;
  loaded(): boolean;
  cache(): ViewCacheStats | null;
  live(): {
    clients: number;
    clientsByCodec: Record<CodecName, number>;
    liveRows: number;
    pendingEvents: number;
    dirtyOrders: number;
    commandsPending: number;
    cpuPercent: number;
    lagMs: { p50: number; p99: number; max: number };
  } | null;
};

const SECONDS_FAST = [0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1];
const SECONDS_SLOW = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const BYTES = [128, 512, 2_048, 8_192, 32_768, 131_072, 524_288, 2_097_152];
const COUNTS = [1, 10, 50, 100, 500, 1_000, 5_000, 10_000];

type Child = { messages: { inc(n?: number): void }; bytes: { inc(n?: number): void } };

/**
 * The antikythera metrics registry (`GET /metrics`). Hot-path counters and histograms are updated inline by the
 * session, runtime and write-behind; state that already lives elsewhere (store size, view cache, client count,
 * process CPU, event-loop lag) is read when Prometheus scrapes.
 */
export class Metrics implements SessionMetrics, RuntimeMetrics {
  readonly registry = new Registry();
  private readonly messages: Counter;
  private readonly bytes: Counter;
  private readonly children = new Map<string, Child>();
  private readonly getRowsSeconds: Histogram;
  private readonly deltaBytes: Histogram;
  private readonly eventAgeSend: Histogram;
  private readonly errors: Counter;
  private readonly backpressureEvents: Counter;
  private readonly flushSeconds: Histogram;
  private readonly eventAgeSeconds: Histogram;
  private readonly ingestEvents: Counter;
  private readonly writeBehindBatch: Histogram;
  private readonly writeBehindSeconds: Histogram;
  private readonly writeBehindFailures: Counter;
  private readonly commandSeconds: Histogram;
  private readonly viewOutcomes: Counter;
  private readonly rebuildSeconds: Histogram;
  private readonly viewsStale: Gauge;
  private readonly viewsPending: Gauge;
  private readonly connections: Gauge;
  private sources: MetricSources | null = null;

  constructor() {
    const registers = [this.registry];
    collectDefaultMetrics({ register: this.registry });
    this.messages = new Counter({
      name: 'apeiron_ws_messages_total',
      help: 'WebSocket messages by direction, protocol message type and codec.',
      labelNames: ['direction', 'type', 'codec'],
      registers,
    });
    this.bytes = new Counter({
      name: 'apeiron_ws_bytes_total',
      help: 'WebSocket payload bytes by direction, protocol message type and codec.',
      labelNames: ['direction', 'type', 'codec'],
      registers,
    });
    this.connections = new Gauge({ name: 'apeiron_ws_connections', help: 'Open WebSocket connections (including ones that have not said hello).', registers });
    this.getRowsSeconds = new Histogram({
      name: 'apeiron_getrows_duration_seconds',
      help: 'Server-side getRows time: cold builds the view, warm hits the cache; flat or grouped.',
      labelNames: ['temp', 'shape'],
      buckets: SECONDS_FAST,
      registers,
    });
    this.deltaBytes = new Histogram({ name: 'apeiron_delta_bytes', help: 'Encoded size of each delta message.', buckets: BYTES, registers });
    this.eventAgeSend = new Histogram({
      name: 'apeiron_event_age_at_send_seconds',
      help: 'Age of the earliest source event (delta.srcTs) in each delta when it is sent: the server-side share of end-to-end tick-to-screen.',
      buckets: SECONDS_FAST,
      registers,
    });
    this.errors = new Counter({ name: 'apeiron_errors_total', help: 'Error messages sent to clients, by error code.', labelNames: ['code'], registers });
    this.backpressureEvents = new Counter({
      name: 'apeiron_backpressure_events_total',
      help: 'soft_conflate: a delta was held back for a client over the soft cap. slow_consumer: a client was closed.',
      labelNames: ['event'],
      registers,
    });
    this.flushSeconds = new Histogram({ name: 'apeiron_flush_duration_seconds', help: 'Duration of one flush tick.', buckets: SECONDS_FAST, registers });
    this.eventAgeSeconds = new Histogram({
      name: 'apeiron_event_age_at_flush_seconds',
      help: 'Age of the oldest queued order event or price tick when its flush ran: the server-side share of tick-to-screen.',
      buckets: SECONDS_FAST,
      registers,
    });
    this.ingestEvents = new Counter({
      name: 'apeiron_ingest_events_total',
      help: 'Events ingested: price ticks, order events, and client commands published.',
      labelNames: ['type'],
      registers,
    });
    this.writeBehindBatch = new Histogram({ name: 'apeiron_write_behind_batch_size', help: 'Orders per write-behind batch.', buckets: COUNTS, registers });
    this.writeBehindSeconds = new Histogram({ name: 'apeiron_write_behind_duration_seconds', help: 'Mongo upsert time per write-behind batch.', buckets: SECONDS_SLOW, registers });
    this.writeBehindFailures = new Counter({ name: 'apeiron_write_behind_failures_total', help: 'Write-behind batches that failed and will be retried.', registers });
    this.commandSeconds = new Histogram({
      name: 'apeiron_command_duration_seconds',
      help: 'Command round trip, from the client request to ack or error. outcome is ok or the error code.',
      labelNames: ['outcome'],
      buckets: SECONDS_SLOW,
      registers,
    });
    this.viewOutcomes = new Counter({
      name: 'apeiron_flush_views_total',
      help: 'Cached views per flush by outcome: patched, deferred (flush budget spent, changes carried over), unsubscribed (no client tracks it, so it is not patched), pending_rebuild (waiting for a deferred rebuild).',
      labelNames: ['outcome'],
      registers,
    });
    this.rebuildSeconds = new Histogram({ name: 'apeiron_view_rebuild_duration_seconds', help: 'Duration of one deferred view rebuild.', buckets: SECONDS_FAST, registers });
    this.viewsStale = new Gauge({ name: 'apeiron_views_stale', help: 'Cached views without derived state because no client tracks them.', registers });
    this.viewsPending = new Gauge({ name: 'apeiron_views_rebuild_pending', help: 'Views waiting for a deferred rebuild after the last flush.', registers });
    this.registerScrapeGauges();
  }

  /** Connects the scrape-time gauges to the running server. */
  bind(sources: MetricSources): void {
    this.sources = sources;
  }

  connectionOpened(): void {
    this.connections.inc();
  }

  connectionClosed(): void {
    this.connections.dec();
  }

  message(direction: Direction, type: string, codec: CodecName, bytes: number): void {
    const key = `${direction}|${type}|${codec}`;
    let child = this.children.get(key);
    if (child === undefined) {
      child = {
        messages: this.messages.labels(direction, type, codec),
        bytes: this.bytes.labels(direction, type, codec),
      };
      this.children.set(key, child);
    }
    child.messages.inc();
    child.bytes.inc(bytes);
  }

  getRows(info: { ms: number; built: boolean; grouped: boolean }): void {
    this.getRowsSeconds.labels(info.built ? 'cold' : 'warm', info.grouped ? 'grouped' : 'flat').observe(info.ms / 1000);
  }

  delta(bytes: number): void {
    this.deltaBytes.observe(bytes);
  }

  eventAgeAtSend(seconds: number): void {
    this.eventAgeSend.observe(seconds);
  }

  error(code: string): void {
    this.errors.labels(code).inc();
  }

  backpressure(event: BackpressureEvent): void {
    this.backpressureEvents.labels(event).inc();
  }

  flush(seconds: number): void {
    this.flushSeconds.observe(seconds);
  }

  eventAge(seconds: number): void {
    this.eventAgeSeconds.observe(seconds);
  }

  ingest(type: IngestType, count = 1): void {
    this.ingestEvents.labels(type).inc(count);
  }

  writeBehind(info: { batchSize: number; seconds: number; ok: boolean }): void {
    if (!info.ok) {
      this.writeBehindFailures.inc();
      return;
    }
    this.writeBehindBatch.observe(info.batchSize);
    this.writeBehindSeconds.observe(info.seconds);
  }

  command(outcome: string, seconds: number): void {
    this.commandSeconds.labels(outcome).observe(seconds);
  }

  views(stats: { patched: number; deferred: number; unsubscribed: number; pendingRebuild: number; stale: number }): void {
    if (stats.patched > 0) this.viewOutcomes.labels('patched').inc(stats.patched);
    if (stats.deferred > 0) this.viewOutcomes.labels('deferred').inc(stats.deferred);
    if (stats.unsubscribed > 0) this.viewOutcomes.labels('unsubscribed').inc(stats.unsubscribed);
    if (stats.pendingRebuild > 0) this.viewOutcomes.labels('pending_rebuild').inc(stats.pendingRebuild);
    this.viewsStale.set(stats.stale);
    this.viewsPending.set(stats.pendingRebuild);
  }

  rebuild(seconds: number): void {
    this.rebuildSeconds.observe(seconds);
  }

  /** The Prometheus text exposition. */
  async render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  /** A gauge whose value is read when the registry is scraped. */
  private scraped(name: string, help: string, update: (gauge: Gauge) => void, labelNames: string[] = []): void {
    const gauge: Gauge = new Gauge({ name, help, labelNames, registers: [this.registry], collect: () => update(gauge) });
  }

  private registerScrapeGauges(): void {
    const sources = (): MetricSources | null => this.sources;
    const live = (): ReturnType<MetricSources['live']> => sources()?.live() ?? null;
    this.scraped('apeiron_store_rows', 'Rows in the columnar store.', (g) => g.set(sources()?.storeRows() ?? 0));
    this.scraped('apeiron_store_loaded', '1 once the store has finished loading.', (g) => g.set(sources()?.loaded() === true ? 1 : 0));
    this.scraped(
      'apeiron_ws_clients',
      'Clients that have said hello, by negotiated codec.',
      (g) => {
        g.labels('json').set(live()?.clientsByCodec.json ?? 0);
        g.labels('msgpack').set(live()?.clientsByCodec.msgpack ?? 0);
      },
      ['codec'],
    );
    this.scraped('apeiron_live_rows', 'Open (LIVE or PAUSED) orders being repriced.', (g) => g.set(live()?.liveRows ?? 0));
    this.scraped('apeiron_ingest_queue_depth', 'Order events queued for the next flush.', (g) => g.set(live()?.pendingEvents ?? 0));
    this.scraped('apeiron_write_behind_queue_depth', 'Orders changed and waiting to be persisted.', (g) => g.set(live()?.dirtyOrders ?? 0));
    this.scraped('apeiron_commands_pending', 'Commands waiting for hermes.', (g) => g.set(live()?.commandsPending ?? 0));
    this.scraped('apeiron_process_cpu_percent', 'Process CPU over the last second, in percent of one core.', (g) => g.set(live()?.cpuPercent ?? 0));
    this.scraped(
      'apeiron_event_loop_lag_seconds',
      'Event-loop lag above the sampling resolution over the last second (quantile 0.5 and 0.99) and its max.',
      (g) => {
        const lag = live()?.lagMs;
        g.labels('0.5').set((lag?.p50 ?? 0) / 1000);
        g.labels('0.99').set((lag?.p99 ?? 0) / 1000);
        g.labels('max').set((lag?.max ?? 0) / 1000);
      },
      ['quantile'],
    );
    this.scraped('apeiron_view_cache_views', 'Views in the cache.', (g) => g.set(sources()?.cache()?.views ?? 0));
    this.scraped('apeiron_view_cache_bytes', 'Index memory held by cached views.', (g) => g.set(sources()?.cache()?.bytes ?? 0));

    const cacheCounters: [string, string, (s: ViewCacheStats) => number][] = [
      ['apeiron_view_cache_hits_total', 'View cache hits.', (s) => s.hits],
      ['apeiron_view_cache_misses_total', 'View cache misses (cold builds).', (s) => s.misses],
      ['apeiron_view_cache_evictions_total', 'Views evicted by the LRU caps or the idle sweep.', (s) => s.evictions],
    ];
    for (const [name, help, pick] of cacheCounters) {
      let last = 0;
      const counter: Counter = new Counter({
        name,
        help,
        registers: [this.registry],
        collect: () => {
          const stats = sources()?.cache();
          if (stats === null || stats === undefined) return;
          const value = pick(stats);
          if (value > last) counter.inc(value - last);
          last = value;
        },
      });
    }
  }
}
