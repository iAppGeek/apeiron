import { NatsBus, ensureStreams } from '@apeiron/iris';
import { MongoOrderRepository } from '@apeiron/mnemosyne';
import { loadConfig } from './config.js';
import { closeServer, startHealthServer } from './health.js';
import { startHermes, type Hermes } from './hermes.js';
import { createLogger } from './log.js';

const config = loadConfig(process.env);
const log = createLogger(config.logLevel);

let hermes: Hermes | null = null;
const health = await startHealthServer(
  config.healthPort,
  () => hermes?.status() ?? { status: 'starting' },
  () => hermes !== null,
);

const repo = await MongoOrderRepository.connect({ url: config.mongoUrl, db: config.mongoDb });
const bus = await NatsBus.connect({ url: config.natsUrl, name: 'hermes', log });

const streams = await ensureStreams(await bus.manager());
log.info({ streams }, 'streams ready');

const current = await repo.loadCurrent();
const maxOrderId = await repo.maxOrderId();
log.info({ current: current.length, maxOrderId }, 'loaded current orders');

hermes = await startHermes({
  bus,
  log,
  preset: config.loadPreset,
  current,
  maxOrderId,
  seed: config.seed ?? Date.now() % 2 ** 31,
  stepMs: config.stepMs,
});
log.info({ preset: config.loadPreset }, 'hermes started');

const shutdown = async (signal: string): Promise<void> => {
  log.info({ signal }, 'shutting down');
  await hermes?.stop();
  await closeServer(health);
  await bus.close();
  await repo.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
