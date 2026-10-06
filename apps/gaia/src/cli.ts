import { MongoOrderRepository } from '@apeiron/mnemosyne';
import { loadConfig } from './config.js';
import { runSeed } from './seed.js';

export type CliDeps = {
  log: (message: string) => void;
  now: () => number;
  connect: typeof MongoOrderRepository.connect;
};

const defaultDeps: CliDeps = {
  log: (m: string): void => console.log(`[gaia] ${m}`),
  now: (): number => Date.now(),
  connect: (options) => MongoOrderRepository.connect(options),
};

/** Seeder entry point. Returns the process exit code. */
export async function runSeedCli(
  env: Record<string, string | undefined>,
  deps: CliDeps = defaultDeps,
): Promise<number> {
  let repo: MongoOrderRepository | undefined;
  try {
    const config = loadConfig(env);
    repo = await deps.connect({ url: config.mongoUrl, db: config.mongoDb });
    await runSeed({
      repo,
      rows: config.rows,
      seed: config.seed,
      now: config.now ?? deps.now(),
      batchSize: config.batchSize,
      log: deps.log,
    });
    return 0;
  } catch (error) {
    deps.log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await repo?.close();
  }
}
