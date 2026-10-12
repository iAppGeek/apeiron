import { NatsBus, ensureStreams, streamSpecs } from '@apeiron/iris';
import { STREAMS } from '@apeiron/logos';
import { loadConfig } from './config.js';
import { closeServer, startHealthServer } from './health.js';
import { startHelios, type Helios } from './helios.js';
import { createLogger } from './log.js';
import { HeliosMetrics } from './metrics.js';
import { startLevels } from './start-levels.js';

const config = loadConfig(process.env);
const log = createLogger(config.logLevel);

const metrics = new HeliosMetrics();
let helios: Helios | null = null;
const health = await startHealthServer(config.healthPort, () => helios?.status() ?? { status: 'starting' }, () => helios !== null, metrics);

const bus = await NatsBus.connect({ url: config.natsUrl, name: 'helios', log });
// helios owns the PRICES stream: one message per subject, so a late joiner can read the last quote.
log.info({ streams: await ensureStreams(await bus.manager(), streamSpecs().filter((s) => s.name === STREAMS.prices)) }, 'streams ready');

const { levels, sources } = await startLevels(bus, log, { refMidsWaitMs: config.refMidsWaitMs });
log.info({ sources }, 'start levels');

helios = startHelios({ bus, log, levels, seed: config.seed ?? Date.now() % 2 ** 31, metrics });
log.info({}, 'helios started');

const shutdown = async (signal: string): Promise<void> => {
  log.info({ signal }, 'shutting down');
  await helios?.stop();
  await closeServer(health);
  await bus.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
