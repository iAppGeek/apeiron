import { NatsBus, ensureStreams, streamSpecs } from '@apeiron/iris';
import { STREAMS } from '@apeiron/logos';
import { MongoOrderRepository } from '@apeiron/mnemosyne';
import { loadConfig } from './config.js';
import { closeServer, startHealthServer } from './health.js';
import { startHermes, type Hermes } from './hermes.js';
import { createLogger } from './log.js';
import { HermesMetrics } from './metrics.js';

const config = loadConfig(process.env);
const log = createLogger(config.logLevel);

const metrics = new HermesMetrics();
let hermes: Hermes | null = null;
const health = await startHealthServer(
  config.healthPort,
  () => hermes?.status() ?? { status: 'starting' },
  () => hermes !== null,
  metrics,
);

// In reports mode the order service owns the database; hermes has no access to it.
const repo =
  config.execMode === 'events' && config.mongoUrl !== undefined ? await MongoOrderRepository.connect({ url: config.mongoUrl, db: config.mongoDb }) : null;
const bus = await NatsBus.connect({ url: config.natsUrl, name: 'hermes', log });

// hermes makes sure the order stream exists; the price feed owns PRICES.
const streams = await ensureStreams(await bus.manager(), streamSpecs().filter((s) => s.name === STREAMS.orders));
log.info({ streams }, 'streams ready');

const current = repo === null ? [] : (await repo.loadOpen()).map((record) => record.order);
const maxOrderId = repo === null ? null : await repo.maxOrderId();
log.info({ mode: config.execMode, current: current.length, maxOrderId }, 'loaded current orders');

hermes = await startHermes({
  bus,
  log,
  preset: config.loadPreset,
  current,
  maxOrderId,
  seed: config.seed ?? Date.now() % 2 ** 31,
  stepMs: config.stepMs,
  priceWaitMs: config.priceWaitMs,
  execMode: config.execMode,
  metrics,
});
log.info({ preset: config.loadPreset }, 'hermes started');

const shutdown = async (signal: string): Promise<void> => {
  log.info({ signal }, 'shutting down');
  await hermes?.stop();
  await closeServer(health);
  await bus.close();
  await repo?.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
