import { NatsBus } from '@apeiron/iris';
import { MongoOrderRepository } from '@apeiron/mnemosyne';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const config = loadConfig(process.env);
const repo = await MongoOrderRepository.connect({ url: config.mongoUrl, db: config.mongoDb });
const bus = config.natsUrl === undefined ? undefined : await NatsBus.connect({ url: config.natsUrl, name: 'antikythera' });
const server = await buildServer({
  repo,
  bus,
  flushMs: config.flushMs,
  writeBehindMs: config.writeBehindMs,
  maxTrackedBlocks: config.maxTrackedBlocks,
  logLevel: config.logLevel,
  storeCapacity: config.storeCapacity,
  viewCacheMaxViews: config.viewCacheMaxViews,
  viewCacheMaxBytes: config.viewCacheMaxBytes,
  maxBlockRows: config.maxBlockRows,
  loadBatchSize: config.loadBatchSize,
});

const shutdown = async (): Promise<void> => {
  await server.app.close();
  await bus?.close();
  await repo.close();
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
