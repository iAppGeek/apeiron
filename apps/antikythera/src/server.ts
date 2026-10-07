import websocket from '@fastify/websocket';
import type { Bus } from '@apeiron/logos';
import type { OrderRepository } from '@apeiron/mnemosyne';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { LiveRuntime } from './live/runtime.js';
import type { BackpressureOptions } from './live/backpressure.js';
import { QueryEngine } from './query/engine.js';
import { LagMonitor, withLagReport } from './lag.js';
import { loadStore, type LoadReport } from './loader.js';
import { memorySnapshot } from './memory.js';
import { ClientSession } from './session.js';
import { ColumnarStore } from './store/columnar-store.js';
import { attachWebSocket } from './ws-transport.js';

export type ServerOptions = {
  repo: OrderRepository;
  /** The message bus. Without one the server is read-only (no live updates, no control). */
  bus?: Bus;
  /** Flush tick length (default 100). */
  flushMs?: number;
  /** Write-behind interval (default 500). */
  writeBehindMs?: number;
  /** Most blocks tracked per client for live deltas (default 100). */
  maxTrackedBlocks?: number;
  backpressure?: BackpressureOptions;
  /** Seconds between summaries are 1s unless a test says otherwise. */
  summaryIntervalMs?: number;
  /** How long a command waits for hermes before the client gets an error (default 5000). */
  commandTimeoutMs?: number;
  logLevel?: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  storeCapacity?: number;
  viewCacheMaxViews?: number;
  viewCacheMaxBytes?: number;
  maxBlockRows?: number;
  /** Rows per batch when streaming the repository (default 200). */
  loadBatchSize?: number;
  /** Largest frame a client may send, in bytes. */
  maxPayload?: number;
  /** A getRows that builds its view in at least this long gets its event-loop lag logged. */
  slowBuildMs?: number;
};

export type HealthBody = {
  status: 'ok' | 'loading' | 'error';
  rows: number;
  loadMs: number;
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
  lag: LagMonitor;
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

  const store = new ColumnarStore({
    capacity: options.storeCapacity,
    onAscendingBroken: (orderId) =>
      app.log.warn({ orderId }, 'an appended orderId is not above the previous one; sorts lose the row-order tiebreak (views will rebuild)'),
  });
  const lag = new LagMonitor();
  lag.start();
  app.addHook('onClose', async () => {
    lag.stop();
    await runtime?.stop();
  });

  let engine: QueryEngine | null = null;
  let runtime: LiveRuntime | null = null;
  let report: LoadReport | null = null;
  let failed = false;
  let loadStarted = 0;
  const slowBuildMs = options.slowBuildMs ?? 50;

  const health = (): HealthBody => {
    const mem = memorySnapshot();
    return {
      status: failed ? 'error' : engine === null ? 'loading' : 'ok',
      rows: store.size,
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

  app.get('/health', async (_req, reply) => {
    const body = health();
    return reply.code(body.status === 'ok' ? 200 : 503).send(body);
  });

  app.get('/debug/lag', async (req) => {
    const reset = (req.query as { reset?: string }).reset === '1';
    if (runtime === null) return { live: false };
    const body = {
      lag: runtime.system.totalLag(),
      server: runtime.system.latest,
      flush: { ...runtime.flushStats, avgMs: runtime.flushStats.flushes === 0 ? 0 : runtime.flushStats.totalMs / runtime.flushStats.flushes },
      writeBehind: runtime.writeBehind.stats,
      live: runtime.live.stats,
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
    attachWebSocket(
      socket,
      (connection) =>
        new ClientSession(connection, {
          engine: () => engine,
          live: () => runtime,
          log: app.log,
          onRows: (info) => {
            if (info.built && info.ms >= slowBuildMs) logSlowBuild(info);
          },
        }).handlers(),
      (error) => app.log.warn({ err: error }, 'socket error'),
    );
  });

  const load = async (): Promise<LoadReport> => {
    loadStarted = performance.now();
    try {
      const result = await loadStore(options.repo, store, {
        monitor: lag,
        batchSize: options.loadBatchSize,
        log: (message, fields) => app.log.info(fields, message),
      });
      engine = new QueryEngine(store, {
        maxViews: options.viewCacheMaxViews ?? 64,
        maxBytes: options.viewCacheMaxBytes ?? 384 * 1024 * 1024,
        maxBlockRows: options.maxBlockRows ?? 5_000,
      });
      report = result;
      if (options.bus !== undefined) {
        runtime = new LiveRuntime({
          store,
          engine,
          repo: options.repo,
          bus: options.bus,
          log: app.log,
          flushMs: options.flushMs ?? 100,
          writeBehindMs: options.writeBehindMs ?? 500,
          maxTrackedBlocks: options.maxTrackedBlocks ?? 100,
          backpressure: options.backpressure,
          summaryIntervalMs: options.summaryIntervalMs,
          commandTimeoutMs: options.commandTimeoutMs,
        });
        runtime.start();
      }
      app.log.info(
        {
          rows: result.rows,
          loadMs: result.loadMs,
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
      return result;
    } catch (error) {
      failed = true;
      app.log.error({ err: error }, 'store load failed');
      throw error;
    }
  };

  return { app, store, load, engine: () => engine, runtime: () => runtime, health, lag };
}
