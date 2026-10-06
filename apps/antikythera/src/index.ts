import { MongoOrderRepository } from '@apeiron/mnemosyne';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const config = loadConfig(process.env);
const repo = await MongoOrderRepository.connect({ url: config.mongoUrl, db: config.mongoDb });
const server = await buildServer({
  repo,
  logLevel: config.logLevel,
  storeCapacity: config.storeCapacity,
  viewCacheMaxViews: config.viewCacheMaxViews,
  viewCacheMaxBytes: config.viewCacheMaxBytes,
  maxBlockRows: config.maxBlockRows,
});

const shutdown = async (): Promise<void> => {
  await server.app.close();
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
