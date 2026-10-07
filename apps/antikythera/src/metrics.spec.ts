import { describe, expect, it } from 'vitest';
import { Metrics, type MetricSources } from './metrics.js';

/** The value of one sample line, e.g. `sample(text, 'apeiron_ws_messages_total{direction="in"...}')`. */
function sample(text: string, series: string): number | undefined {
  const line = text.split('\n').find((l) => l.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
}

const sources = (over: Partial<MetricSources> = {}): MetricSources => ({
  storeRows: () => 1234,
  loaded: () => true,
  cache: () => ({ views: 3, bytes: 4096, hits: 10, misses: 2, evictions: 1 }),
  live: () => ({
    clients: 3,
    clientsByCodec: { json: 2, msgpack: 1 },
    liveRows: 500,
    pendingEvents: 7,
    dirtyOrders: 9,
    commandsPending: 1,
    cpuPercent: 42.5,
    lagMs: { p50: 1, p99: 20, max: 40 },
  }),
  ...over,
});

describe('Metrics', () => {
  it('exposes the default process metrics', async () => {
    const text = await new Metrics().render();
    expect(text).toContain('process_cpu_seconds_total');
    expect(text).toContain('process_resident_memory_bytes');
    expect(text).toContain('nodejs_heap_size_used_bytes');
    expect(text).toContain('nodejs_gc_duration_seconds');
    expect(text).toContain('nodejs_eventloop_lag_p99_seconds');
  });

  it('counts messages and bytes by direction, type and codec, and connections up and down', async () => {
    const m = new Metrics();
    m.message('out', 'delta', 'msgpack', 100);
    m.message('out', 'delta', 'msgpack', 50);
    m.message('in', 'getRows', 'json', 30);
    m.connectionOpened();
    m.connectionOpened();
    m.connectionClosed();
    const text = await m.render();
    expect(sample(text, 'apeiron_ws_messages_total{direction="out",type="delta",codec="msgpack"}')).toBe(2);
    expect(sample(text, 'apeiron_ws_bytes_total{direction="out",type="delta",codec="msgpack"}')).toBe(150);
    expect(sample(text, 'apeiron_ws_bytes_total{direction="in",type="getRows",codec="json"}')).toBe(30);
    expect(sample(text, 'apeiron_ws_connections')).toBe(1);
  });

  it('labels getRows by cold or warm and flat or grouped, and observes seconds', async () => {
    const m = new Metrics();
    m.getRows({ ms: 20, built: true, grouped: false });
    m.getRows({ ms: 2, built: false, grouped: true });
    const text = await m.render();
    expect(sample(text, 'apeiron_getrows_duration_seconds_count{temp="cold",shape="flat"}')).toBe(1);
    expect(sample(text, 'apeiron_getrows_duration_seconds_sum{temp="cold",shape="flat"}')).toBeCloseTo(0.02, 5);
    expect(sample(text, 'apeiron_getrows_duration_seconds_count{temp="warm",shape="grouped"}')).toBe(1);
  });

  it('records flush, event age, ingest, write-behind, command, delta, error and backpressure measurements', async () => {
    const m = new Metrics();
    m.flush(0.003);
    m.eventAge(0.05);
    m.ingest('price');
    m.ingest('price', 4);
    m.ingest('order');
    m.writeBehind({ batchSize: 40, seconds: 0.01, ok: true });
    m.writeBehind({ batchSize: 40, seconds: 0.01, ok: false });
    m.command('ok', 0.02);
    m.command('INVALID_TRANSITION', 0.001);
    m.delta(900);
    m.error('BAD_MESSAGE');
    m.backpressure('soft_conflate');
    m.backpressure('slow_consumer');
    const text = await m.render();
    expect(sample(text, 'apeiron_flush_duration_seconds_count')).toBe(1);
    expect(sample(text, 'apeiron_event_age_at_flush_seconds_count')).toBe(1);
    expect(sample(text, 'apeiron_ingest_events_total{type="price"}')).toBe(5);
    expect(sample(text, 'apeiron_ingest_events_total{type="order"}')).toBe(1);
    expect(sample(text, 'apeiron_write_behind_batch_size_sum')).toBe(40);
    expect(sample(text, 'apeiron_write_behind_failures_total')).toBe(1);
    expect(sample(text, 'apeiron_command_duration_seconds_count{outcome="ok"}')).toBe(1);
    expect(sample(text, 'apeiron_command_duration_seconds_count{outcome="INVALID_TRANSITION"}')).toBe(1);
    expect(sample(text, 'apeiron_delta_bytes_count')).toBe(1);
    expect(sample(text, 'apeiron_errors_total{code="BAD_MESSAGE"}')).toBe(1);
    expect(sample(text, 'apeiron_backpressure_events_total{event="soft_conflate"}')).toBe(1);
    expect(sample(text, 'apeiron_backpressure_events_total{event="slow_consumer"}')).toBe(1);
  });

  it('counts what each flush did with the views, and times deferred rebuilds', async () => {
    const m = new Metrics();
    m.views({ patched: 3, deferred: 2, unsubscribed: 5, pendingRebuild: 1, stale: 7 });
    m.views({ patched: 1, deferred: 0, unsubscribed: 0, pendingRebuild: 0, stale: 4 });
    m.rebuild(0.05);
    const text = await m.render();
    expect(sample(text, 'apeiron_flush_views_total{outcome="patched"}')).toBe(4);
    expect(sample(text, 'apeiron_flush_views_total{outcome="deferred"}')).toBe(2);
    expect(sample(text, 'apeiron_flush_views_total{outcome="unsubscribed"}')).toBe(5);
    expect(sample(text, 'apeiron_flush_views_total{outcome="pending_rebuild"}')).toBe(1);
    expect(sample(text, 'apeiron_views_stale')).toBe(4);
    expect(sample(text, 'apeiron_views_rebuild_pending')).toBe(0);
    expect(sample(text, 'apeiron_view_rebuild_duration_seconds_count')).toBe(1);
  });

  it('reads store, cache, client and lag gauges from the bound sources at scrape time', async () => {
    const m = new Metrics();
    expect(sample(await m.render(), 'apeiron_store_rows')).toBe(0);
    m.bind(sources());
    const text = await m.render();
    expect(sample(text, 'apeiron_store_rows')).toBe(1234);
    expect(sample(text, 'apeiron_store_loaded')).toBe(1);
    expect(sample(text, 'apeiron_ws_clients{codec="json"}')).toBe(2);
    expect(sample(text, 'apeiron_ws_clients{codec="msgpack"}')).toBe(1);
    expect(sample(text, 'apeiron_live_rows')).toBe(500);
    expect(sample(text, 'apeiron_write_behind_queue_depth')).toBe(9);
    expect(sample(text, 'apeiron_process_cpu_percent')).toBe(42.5);
    expect(sample(text, 'apeiron_event_loop_lag_seconds{quantile="0.99"}')).toBeCloseTo(0.02, 6);
    expect(sample(text, 'apeiron_view_cache_views')).toBe(3);
    expect(sample(text, 'apeiron_view_cache_bytes')).toBe(4096);
    expect(sample(text, 'apeiron_view_cache_hits_total')).toBe(10);
    expect(sample(text, 'apeiron_view_cache_misses_total')).toBe(2);
    expect(sample(text, 'apeiron_view_cache_evictions_total')).toBe(1);
  });

  it('turns the cache counters into increments, so repeated scrapes do not double count', async () => {
    const m = new Metrics();
    let hits = 5;
    m.bind(sources({ cache: () => ({ views: 1, bytes: 1, hits, misses: 0, evictions: 0 }) }));
    await m.render();
    await m.render();
    expect(sample(await m.render(), 'apeiron_view_cache_hits_total')).toBe(5);
    hits = 8;
    expect(sample(await m.render(), 'apeiron_view_cache_hits_total')).toBe(8);
  });

  it('never labels by client or order id', async () => {
    const m = new Metrics();
    m.message('out', 'rows', 'json', 1);
    m.command('ok', 0.1);
    const labelNames = new Set([...(await m.render()).matchAll(/\{([^}]*)\}/g)].flatMap((x) => (x[1] ?? '').split(',').map((p) => p.split('=')[0])));
    expect(labelNames.has('clientId')).toBe(false);
    expect(labelNames.has('orderId')).toBe(false);
  });
});
