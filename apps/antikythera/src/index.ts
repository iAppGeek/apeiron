import { NatsBus } from '@apeiron/iris';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

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
  catchupMaxPending: config.catchupMaxPending,
  heartbeat: { intervalMs: Math.max(250, Math.floor(config.heartbeatTimeoutMs / 3)), timeoutMs: config.heartbeatTimeoutMs },
  // The store can no longer be kept current: exit so the container restarts and loads a fresh snapshot.
  onFatal: () => process.exit(1),
});

const shutdown = async (): Promise<void> => {
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
