import { NatsBus } from '@apeiron/iris';
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

const bus = await NatsBus.connect({ url: config.natsUrl, name: 'hermes', log });

// hermes has no database and creates nothing: the open orders come from the order service, which owns the streams, and
// everything it does is a message.

hermes = await startHermes({
  bus,
  log,
  preset: config.loadPreset,
  seed: config.seed ?? Date.now() % 2 ** 31,
  stepMs: config.stepMs,
  priceWaitMs: config.priceWaitMs,
  metrics,
});
log.info({ preset: config.loadPreset }, 'hermes started');

const shutdown = async (signal: string): Promise<void> => {
  log.info({ signal }, 'shutting down');
  await hermes?.stop();
  await closeServer(health);
  await bus.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
