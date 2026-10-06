import { generateOrders } from '@apeiron/logos';
import { InMemoryOrderRepository, type OrderRepository } from '@apeiron/mnemosyne';
import { describe, expect, it, vi } from 'vitest';
import { runSeed } from './seed.js';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

function setup(): { repo: InMemoryOrderRepository; log: ReturnType<typeof vi.fn<(m: string) => void>> } {
  return { repo: new InMemoryOrderRepository(), log: vi.fn<(m: string) => void>() };
}

async function loadIds(repo: OrderRepository): Promise<string[]> {
  const ids: string[] = [];
  for await (const batch of repo.loadAll()) ids.push(...batch.map((o) => o.orderId));
  return ids;
}

describe('runSeed', () => {
  it('writes exactly the requested deterministic rows', async () => {
    const { repo, log } = setup();
    const result = await runSeed({ repo, rows: 2500, seed: 42, now: NOW, batchSize: 1000, log });
    expect(result).toMatchObject({ skipped: false, existingRows: 0, rowsWritten: 2500 });
    expect(result.rowsPerSec).toBeGreaterThan(0);
    expect(await repo.count()).toBe(2500);
    const expected = [...generateOrders(42, 2500, NOW)].map((o) => o.orderId).sort();
    expect(await loadIds(repo)).toEqual(expected);
  });

  it('is a no-op on the second run', async () => {
    const { repo, log } = setup();
    await runSeed({ repo, rows: 1000, seed: 1, now: NOW, log });
    const spy = vi.spyOn(repo, 'upsertMany');
    const second = await runSeed({ repo, rows: 1000, seed: 1, now: NOW, log });
    expect(second).toMatchObject({ skipped: true, existingRows: 1000, rowsWritten: 0 });
    expect(spy).not.toHaveBeenCalled();
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('Already seeded'));
  });

  it('completes a partial dataset by re-upserting', async () => {
    const { repo, log } = setup();
    await repo.upsertMany([...generateOrders(5, 1000, NOW)].slice(0, 300));
    const result = await runSeed({ repo, rows: 1000, seed: 5, now: NOW, log });
    expect(result.skipped).toBe(false);
    expect(await repo.count()).toBe(1000);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('partial dataset'));
  });

  it('logs progress with rows per second', async () => {
    const { repo, log } = setup();
    let t = 0;
    await runSeed({
      repo,
      rows: 1000,
      seed: 1,
      now: NOW,
      batchSize: 100,
      progressEvery: 400,
      maxInFlight: 1,
      log,
      clock: () => (t += 1000),
    });
    const lines = log.mock.calls.map((c) => c[0]);
    expect(lines.some((l) => /400 \/ 1,000 rows \(\d+ rows\/s\)/.test(l))).toBe(true);
    expect(lines.some((l) => /Seeded 1,000 rows in/.test(l))).toBe(true);
  });

  it('propagates write failures', async () => {
    const { repo, log } = setup();
    vi.spyOn(repo, 'upsertMany').mockRejectedValue(new Error('disk full'));
    await expect(runSeed({ repo, rows: 500, seed: 1, now: NOW, batchSize: 100, log })).rejects.toThrow('disk full');
  });

  it('keeps several writes in flight', async () => {
    const { repo, log } = setup();
    let active = 0;
    let peak = 0;
    vi.spyOn(repo, 'upsertMany').mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    await runSeed({ repo, rows: 1000, seed: 1, now: NOW, batchSize: 100, maxInFlight: 3, log });
    expect(peak).toBe(3);
  });
});
