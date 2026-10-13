import websocket from '@fastify/websocket';
import type { Bus, Entitlements } from '@apeiron/logos';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { LiveRuntime, type Stage } from './live/runtime.js';
import type { WarmEntry } from './warmup.js';
import type { BackpressureOptions } from './live/backpressure.js';
import { QueryEngine } from './query/engine.js';
import { LagMonitor, withLagReport } from './lag.js';
import { Metrics } from './metrics.js';
import { loadSnapshot, type LoadReport } from './snapshot.js';
import { memorySnapshot } from './memory.js';
import { ClientSession } from './session.js';
import { ColumnarStore } from './store/columnar-store.js';
import { attachWebSocket, DEFAULT_HEARTBEAT, type HeartbeatOptions } from './ws-transport.js';

export type ServerOptions = {
  /** The message bus: the blotter's only source of data. */
  bus: Bus;
  /** Who may sign in and which traders each may see and act on. */
  entitlements: Entitlements;
  /** Flush tick length (default 50). */
  flushMs?: number;
  /** Most blocks tracked per client for live deltas (default 100). */
  maxTrackedBlocks?: number;
  backpressure?: BackpressureOptions;
  /** Seconds between summaries are 1s unless a test says otherwise. */
  summaryIntervalMs?: number;
  /** How long a command waits for the order service's reply before the client gets INTERNAL (default 5000). */
  commandTimeoutMs?: number;
  /** After the order service accepts a command, the longest the ack waits for the store to hold the new version (default 2000). */
  ackWaitVMs?: number;
  logLevel?: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  storeCapacity?: number;
  viewCacheMaxViews?: number;
  viewCacheMaxBytes?: number;
  maxBlockRows?: number;
  /** Most time to wait at startup for a price for every pair (default 10 s). */
  priceWaitMs?: number;
  /** Caught up once a watch entry has at most this many pending behind it (default 100). */
  catchupMaxPending?: number;
  /** Views to build before the blotter is ready, and passes over each (see `warmup.ts`). Default: none. */
  warmViews?: readonly WarmEntry[];
  warmRounds?: number;
  /** Called when the order-state watch ends and the process can no longer be kept current. */
  onFatal?: (reason: string) => void;
  /** Wait between looks at the projection marker, and before retrying an incomplete snapshot (tests shorten them). */
  snapshotPollMs?: number;
  snapshotRetryMs?: number;
  /** Largest frame a client may send, in bytes. */
  maxPayload?: number;
  /** A getRows that builds its view in at least this long gets its event-loop lag logged. */
  slowBuildMs?: number;
  /** Most time one flush may spend patching views (default 40 ms). */
  flushBudgetMs?: number;
  /** The metrics registry served on `/metrics` (default: a new one). */
  metrics?: Metrics;
  /** Server-side ping and silence timeout (default 5s / 15s); null disables it. */
  heartbeat?: HeartbeatOptions | null;
};

export type HealthBody = {
  status: 'ok' | 'loading' | 'draining' | 'error';
  stage: Stage;
  rows: number;
  loadMs: number;
  /** How long the snapshot took, and the warm-up (0 until they have run). */
  snapshotMs: number;
  warmupMs: number;
  heapMb: number;
  rssMb: number;
  live?: { attached: boolean; clients: number; liveRows: number; pendingEvents: number };
};

export type BlotterServer = {
  app: FastifyInstance;
  store: ColumnarStore;
  /** Starts loading the repository into the store (call once, after the server is listening). */
  load(): Promise<LoadReport>;
  /** The engine once loading has finished, else null. */
  engine(): QueryEngine | null;
  /** The live runtime once loading has finished and a bus was given, else null. */
  runtime(): LiveRuntime | null;
  health(): HealthBody;
  /**
   * Stops being ready (`/health/ready` says 503 at once, new WebSocket upgrades are refused), waits `drainMs` so
   * whatever routes traffic notices, then closes every socket with code 1012 so clients reconnect at once.
   */
  drain(drainMs?: number): Promise<void>;
  lag: LagMonitor;
  metrics: Metrics;
};


/**
 * Builds the Fastify app: `GET /health` (503 until the store is loaded) and `GET /ws` (Appendix C).
 * Listening and loading are separate steps so the process answers health checks while it loads.
 */
export async function buildServer(options: ServerOptions): Promise<BlotterServer> {
  const app = Fastify({
    logger: { level: options.logLevel ?? 'info' },
    // Health checks and every WebSocket upgrade would otherwise log two lines each.
    logController: new LogController({ disableRequestLogging: true }),
  });
  await app.register(websocket, { options: { maxPayload: options.maxPayload ?? 1_048_576 } });

  let loading = true;
  const store = new ColumnarStore({
    capacity: options.storeCapacity,
    // The snapshot reads orders in the order they last changed and sorts them at the end; only later breaks matter.
    onAscendingBroken: (orderId) => {
      if (!loading) {
        app.log.warn({ orderId }, 'an appended orderId is not above the previous one; sorts lose the row-order tiebreak (views will rebuild)');
      }
    },
  });
  const lag = new LagMonitor();
  lag.start();
  const metrics = options.metrics ?? new Metrics();
  app.addHook('onClose', async () => {
    lag.stop();
    await runtime?.stop();
  });

  let engine: QueryEngine | null = null;
  let runtime: LiveRuntime | null = null;
  let report: LoadReport | null = null;
  let failed = false;
  let draining = false;
  const sockets = new Set<{ close(code?: number, reason?: string): void }>();
  let loadStarted = 0;
  const slowBuildMs = options.slowBuildMs ?? 50;

  const health = (): HealthBody => {
    const mem = memorySnapshot();
    return {
      status: failed ? 'error' : draining ? 'draining' : runtime?.stage === 'ready' ? 'ok' : 'loading',
      stage: draining ? 'draining' : (runtime?.stage ?? 'snapshot'),
      rows: store.size,
      snapshotMs: report?.loadMs ?? 0,
      warmupMs: runtime?.warmup?.ms ?? 0,
      loadMs: report?.loadMs ?? (loadStarted === 0 ? 0 : Math.round(performance.now() - loadStarted)),
      heapMb: mem.heapMb,
      rssMb: mem.rssMb,
      ...(runtime === null
        ? {}
        : {
            live: {
              attached: runtime.isAttached,
              clients: runtime.clientCount,
              liveRows: runtime.live.liveRows,
              pendingEvents: runtime.live.pendingEvents,
            },
          }),
    };
  };

  // Liveness: the process is up. Readiness (and `/health`, its alias): loaded, caught up, priced and warm.
  app.get('/health/live', async () => ({ status: 'live' }));
  const ready = async (_req: unknown, reply: { code(n: number): { send(b: unknown): unknown } }): Promise<unknown> => {
    const body = health();
    return reply.code(body.status === 'ok' ? 200 : 503).send(body);
  };
  app.get('/health/ready', ready);
  app.get('/health', ready);

  app.addHook('onRequest', async (req, reply) => {
    if (draining && req.url.split('?')[0] === '/ws') await reply.code(503).send({ error: 'draining' });
  });

  metrics.bind({
    storeRows: () => store.size,
    loaded: () => runtime?.stage === 'ready',
    cache: () => engine?.stats().cache ?? null,
    live: () =>
      runtime === null
        ? null
        : {
            clients: runtime.clientCount,
            clientsByCodec: runtime.clientsByCodec(),
            liveRows: runtime.live.liveRows,
            pendingEvents: runtime.live.pendingEvents,
            commandsPending: runtime.commands.size,
            cpuPercent: runtime.system.latest.cpu,
            lagMs: runtime.system.lastWindowLag,
          },
  });

  app.get('/metrics', async (_req, reply) => reply.header('content-type', metrics.contentType).send(await metrics.render()));

  app.get('/debug/lag', async (req) => {
    const reset = (req.query as { reset?: string }).reset === '1';
    if (runtime === null) return { live: false };
    const body = {
      lag: runtime.system.totalLag(),
      server: runtime.system.latest,
      flush: { ...runtime.flushStats, avgMs: runtime.flushStats.flushes === 0 ? 0 : runtime.flushStats.totalMs / runtime.flushStats.flushes },
      live: runtime.live.stats,
      stage: runtime.stage,
      appliedRev: runtime.live.appliedRevision,
      records: { applied: runtime.live.stats.recordsApplied, ignored: runtime.ignoredCounts },
      lastTickTs: runtime.live.lastTickTs(),
      clients: runtime.clientCount,
    };
    if (reset) {
      runtime.system.resetTotalLag();
      runtime.flushStats.maxMs = 0;
    }
    return body;
  });

  const logSlowBuild = (info: { ms: number; rowCount: number }): void => {
    // The lag histogram only records a stall once the loop turns again, so read it a moment later.
    void withLagReport(lag, () => undefined).then(({ lag: snapshot }) => {
      app.log.info({ ms: Math.round(info.ms), rowCount: info.rowCount, lag: snapshot }, 'cold view build');
    });
  };

  app.get('/ws', { websocket: true }, (socket) => {
    metrics.connectionOpened();
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
      metrics.connectionClosed();
    });
    attachWebSocket(
      socket,
      (connection) =>
        new ClientSession(connection, {
          // No client is served rows before the blotter is ready: loaded, caught up and priced.
          entitlements: options.entitlements,
          engine: () => (runtime?.stage === 'ready' || runtime?.stage === 'draining' ? engine : null),
          live: () => runtime,
          log: app.log,
          metrics,
          onRows: (info) => {
            if (info.built && info.ms >= slowBuildMs) logSlowBuild(info);
          },
        }).handlers(),
      (error) => app.log.warn({ err: error }, 'socket error'),
      options.heartbeat === undefined ? DEFAULT_HEARTBEAT : options.heartbeat,
    );
  });

  const load = async (): Promise<LoadReport> => {
    loadStarted = performance.now();
    try {
      const snapshot = await loadSnapshot({
        bus: options.bus,
        store,
        monitor: lag,
        log: (message, fields) => app.log.info(fields, message),
        ...(options.snapshotPollMs === undefined ? {} : { markerPollMs: options.snapshotPollMs }),
        ...(options.snapshotRetryMs === undefined ? {} : { retryMs: options.snapshotRetryMs }),
      });
      loading = false;
      const result = snapshot.report;
      metrics.startup('snapshot', result.loadMs / 1000);
      engine = new QueryEngine(store, {
        maxViews: options.viewCacheMaxViews ?? 64,
        maxBytes: options.viewCacheMaxBytes ?? 384 * 1024 * 1024,
        maxBlockRows: options.maxBlockRows ?? 5_000,
      });
      report = result;
      let becameReady: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => {
        becameReady = resolve;
      });
      runtime = new LiveRuntime({
        store,
        engine,
        bus: options.bus,
        log: app.log,
        flushMs: options.flushMs ?? 50,
        maxTrackedBlocks: options.maxTrackedBlocks ?? 100,
        backpressure: options.backpressure,
        summaryIntervalMs: options.summaryIntervalMs,
        commandTimeoutMs: options.commandTimeoutMs,
        ackWaitVMs: options.ackWaitVMs,
        metrics,
        flushBudgetMs: options.flushBudgetMs,
        snapshot: snapshot,
        priceWaitMs: options.priceWaitMs,
        catchupMaxPending: options.catchupMaxPending,
        onFatal: options.onFatal,
        warmViews: options.warmViews,
        warmRounds: options.warmRounds,
        onStage: (finished) => {
          if (finished === 'warmup') becameReady();
        },
      });
      runtime.live.noteRevision(snapshot.revision);
      runtime.start();
      app.log.info(
        {
          rows: result.rows,
          loadMs: result.loadMs,
          sortMs: result.sortMs,
          rankMs: result.rankMs,
          streamedRssMb: result.streamedRssMb,
          peakRssMb: result.peakRssMb,
          heapMb: result.before.heapMb,
          rssMb: result.before.rssMb,
          heapAfterGcMb: result.afterGc?.heapMb,
          rssAfterGcMb: result.afterGc?.rssMb,
          arrayBuffersMb: result.afterGc?.arrayBuffersMb,
          typedArrayMb: Math.round(result.store.typedUsedBytes / 1048576),
          lag: result.lag,
        },
        'store loaded',
      );
      await ready;
      return result;
    } catch (error) {
      failed = true;
      app.log.error({ err: error }, 'store load failed');
      throw error;
    }
  };

  const drain = async (drainMs = 2_000): Promise<void> => {
    if (draining) return;
    draining = true;
    runtime?.drain();
    app.log.info({ drainMs, clients: sockets.size }, 'draining');
    await new Promise<void>((resolve) => setTimeout(resolve, drainMs));
    for (const socket of [...sockets]) socket.close(1012, 'server restarting');
    // Give the close handshakes a moment; a socket that does not answer is dropped with the server.
    const deadline = Date.now() + 1_000;
    while (sockets.size > 0 && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 10));
  };

  return { app, store, load, drain, engine: () => engine, runtime: () => runtime, health, lag, metrics };
}
