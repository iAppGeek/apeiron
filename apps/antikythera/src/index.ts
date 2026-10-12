import { NatsBus } from '@apeiron/iris';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';
import { loadWarmViews } from './warmup.js';

const config = loadConfig(process.env);
const bus = await NatsBus.connect({ url: config.natsUrl, name: 'antikythera' });
const server = await buildServer({
  bus,
  flushMs: config.flushMs,
  maxTrackedBlocks: config.maxTrackedBlocks,
  logLevel: config.logLevel,
  storeCapacity: config.storeCapacity,
  viewCacheMaxViews: config.viewCacheMaxViews,
  viewCacheMaxBytes: config.viewCacheMaxBytes,
  maxBlockRows: config.maxBlockRows,
  flushBudgetMs: config.flushBudgetMs,
  priceWaitMs: config.priceWaitMs,
  warmViews: loadWarmViews(config.warmViews),
  warmRounds: config.warmRounds,
  catchupMaxPending: config.catchupMaxPending,
  heartbeat: { intervalMs: Math.max(250, Math.floor(config.heartbeatTimeoutMs / 3)), timeoutMs: config.heartbeatTimeoutMs },
  // The store can no longer be kept current: exit so the container restarts and loads a fresh snapshot.
  onFatal: () => process.exit(1),
});

const shutdown = async (): Promise<void> => {
  // Say "not ready", then close every socket with 1012 so clients reconnect at once to whatever comes next.
  await server.drain(config.drainMs);
  await server.app.close();
  await bus.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

await server.app.listen({ port: config.port, host: config.host });
try {
  await server.load();
} catch {
  process.exit(1);
}
