import websocket from '@fastify/websocket';
import type { OrderRepository } from '@apeiron/mnemosyne';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { QueryEngine } from './query/engine.js';
import { LagMonitor, withLagReport } from './lag.js';
import { loadStore, type LoadReport } from './loader.js';
import { memorySnapshot } from './memory.js';
import { ClientSession } from './session.js';
import { ColumnarStore } from './store/columnar-store.js';
import { attachWebSocket } from './ws-transport.js';

export type ServerOptions = {
  repo: OrderRepository;
  logLevel?: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  storeCapacity?: number;
  viewCacheMaxViews?: number;
  viewCacheMaxBytes?: number;
  maxBlockRows?: number;
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
};

export type BlotterServer = {
  app: FastifyInstance;
  store: ColumnarStore;
  /** Starts loading the repository into the store (call once, after the server is listening). */
  load(): Promise<LoadReport>;
  /** The engine once loading has finished, else null. */
  engine(): QueryEngine | null;
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

  const store = new ColumnarStore({ capacity: options.storeCapacity });
  const lag = new LagMonitor();
  lag.start();
  app.addHook('onClose', () => {
    lag.stop();
  });

  let engine: QueryEngine | null = null;
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
    };
  };

  app.get('/health', async (_req, reply) => {
    const body = health();
    return reply.code(body.status === 'ok' ? 200 : 503).send(body);
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
        log: (message, fields) => app.log.info(fields, message),
      });
      engine = new QueryEngine(store, {
        maxViews: options.viewCacheMaxViews ?? 64,
        maxBytes: options.viewCacheMaxBytes ?? 384 * 1024 * 1024,
        maxBlockRows: options.maxBlockRows ?? 5_000,
      });
      report = result;
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

  return { app, store, load, engine: () => engine, health, lag };
}
