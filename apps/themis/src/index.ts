import { NatsBus, ensureStreams, streamSpecs } from '@apeiron/iris';
import { STREAMS } from '@apeiron/logos';
import { MongoOrderRepository } from '@apeiron/mnemosyne';
import { loadConfig } from './config.js';
import { closeServer, startHealthServer } from './health.js';
import { createLogger } from './log.js';
import { ThemisMetrics } from './metrics.js';
import { startThemis, type Themis } from './themis.js';

// The order service owns the streams it reads and writes; the price feed owns PRICES.
const OWNED_STREAMS: readonly string[] = [STREAMS.exec, STREAMS.venue];

const config = loadConfig(process.env);
const log = createLogger(config.logLevel);

const metrics = new ThemisMetrics();
let themis: Themis | null = null;
const health = await startHealthServer(
  config.healthPort,
  () => themis?.status() ?? { status: 'starting' },
  () => themis !== null,
  metrics,
  () => themis?.debug() ?? {},
);

const repo = await MongoOrderRepository.connect({ url: config.mongoUrl, db: config.mongoDb });
const bus = await NatsBus.connect({ url: config.natsUrl, name: 'themis', log });

// themis starts before the simulator, so it makes sure the streams it reads exist (idempotent).
log.info({ streams: await ensureStreams(await bus.manager(), streamSpecs().filter((s) => OWNED_STREAMS.includes(s.name))) }, 'streams ready');

themis = await startThemis({
  bus,
  repo,
  log,
  groupCommitMs: config.groupCommitMs,
  groupCommitMax: config.groupCommitMax,
  reconcileWindowMin: config.reconcileWindowMin,
  rebuildProjection: config.rebuildProjection,
  venueTimeoutMs: config.venueTimeoutMs,
  metrics,
});
log.info({}, 'themis ready');

const shutdown = async (signal: string): Promise<void> => {
  log.info({ signal }, 'shutting down');
  await themis?.stop();
  await closeServer(health);
  await bus.close();
  await repo.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
