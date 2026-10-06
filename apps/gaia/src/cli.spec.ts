import { InMemoryOrderRepository, type MongoOrderRepository } from '@apeiron/mnemosyne';
import { describe, expect, it, vi } from 'vitest';
import { runSeedCli, type CliDeps } from './cli.js';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

function makeDeps(): { deps: CliDeps; repo: InMemoryOrderRepository & { close: ReturnType<typeof vi.fn<() => Promise<void>>> }; log: ReturnType<typeof vi.fn<(m: string) => void>> } {
  const repo = Object.assign(new InMemoryOrderRepository(), { close: vi.fn<() => Promise<void>>().mockResolvedValue() });
  const log = vi.fn<(m: string) => void>();
  const deps: CliDeps = {
    log,
    now: () => NOW,
    connect: vi.fn().mockResolvedValue(repo as unknown as MongoOrderRepository),
  };
  return { deps, repo, log };
}

describe('runSeedCli', () => {
  it('seeds, closes the connection and returns 0', async () => {
    const { deps, repo } = makeDeps();
    const code = await runSeedCli({ MONGO_URL: 'mongodb://h', SEED_ROWS: '500' }, deps);
    expect(code).toBe(0);
    expect(await repo.count()).toBe(500);
    expect(repo.close).toHaveBeenCalledOnce();
    expect(deps.connect).toHaveBeenCalledWith({ url: 'mongodb://h', db: 'blotter' });
  });

  it('is a no-op when already seeded', async () => {
    const { deps, repo, log } = makeDeps();
    const env = { MONGO_URL: 'mongodb://h', SEED_ROWS: '500' };
    await runSeedCli(env, deps);
    expect(await runSeedCli(env, deps)).toBe(0);
    expect(await repo.count()).toBe(500);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Already seeded'));
  });

  it('re-seeds with SEED_RESET=true', async () => {
    const { deps, repo } = makeDeps();
    const env = { MONGO_URL: 'mongodb://h', SEED_ROWS: '300' };
    await runSeedCli(env, deps);
    const clear = vi.spyOn(repo, 'clear');
    expect(await runSeedCli({ ...env, SEED_RESET: 'true' }, deps)).toBe(0);
    expect(clear).toHaveBeenCalledOnce();
    expect(await repo.count()).toBe(300);
  });

  it('returns 1 on invalid configuration without connecting', async () => {
    const { deps, log } = makeDeps();
    expect(await runSeedCli({}, deps)).toBe(1);
    expect(deps.connect).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('FAILED'));
  });

  it('returns 1 and still closes when seeding fails', async () => {
    const { deps, repo } = makeDeps();
    vi.spyOn(repo, 'upsertMany').mockRejectedValue(new Error('boom'));
    expect(await runSeedCli({ MONGO_URL: 'mongodb://h', SEED_ROWS: '200' }, deps)).toBe(1);
    expect(repo.close).toHaveBeenCalledOnce();
  });
});
