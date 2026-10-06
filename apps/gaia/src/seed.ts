import { generateOrderBatches } from '@apeiron/logos';
import type { OrderRepository } from '@apeiron/mnemosyne';

export type SeedParams = {
  repo: OrderRepository;
  rows: number;
  seed: number;
  now: number;
  batchSize?: number;
  /** Concurrent bulk writes. */
  maxInFlight?: number;
  log: (message: string) => void;
  clock?: () => number;
  /** Log a progress line every this many rows. */
  progressEvery?: number;
};

export type SeedResult = {
  skipped: boolean;
  existingRows: number;
  rowsWritten: number;
  elapsedMs: number;
  rowsPerSec: number;
};

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

/**
 * Generates `rows` deterministic orders and upserts them in batches. Idempotent: when the repository
 * already holds at least `rows` orders nothing is written. A partial earlier run is completed by
 * re-upserting the same deterministic data.
 */
export async function runSeed(params: SeedParams): Promise<SeedResult> {
  const { repo, rows, seed, now, log } = params;
  const batchSize = params.batchSize ?? 10_000;
  const maxInFlight = params.maxInFlight ?? 4;
  const clock = params.clock ?? ((): number => performance.now());
  const progressEvery = params.progressEvery ?? 100_000;

  const existingRows = await repo.count();
  if (existingRows >= rows) {
    log(`Already seeded: ${fmt(existingRows)} rows present (target ${fmt(rows)}). Nothing to do.`);
    return { skipped: true, existingRows, rowsWritten: 0, elapsedMs: 0, rowsPerSec: 0 };
  }
  if (existingRows > 0) {
    log(`Found a partial dataset (${fmt(existingRows)} of ${fmt(rows)} rows). Re-upserting to complete it.`);
  }

  log(`Seeding ${fmt(rows)} rows (seed=${seed}, now=${new Date(now).toISOString()}, batch=${fmt(batchSize)})`);
  const start = clock();
  let written = 0;
  let nextProgress = progressEvery;
  let failure: unknown;
  const inFlight = new Set<Promise<void>>();

  for (const batch of generateOrderBatches({ seed, n: rows, now, batchSize })) {
    const task: Promise<void> = repo
      .upsertMany(batch)
      .then((): void => {
        written += batch.length;
        if (written >= nextProgress) {
          nextProgress += progressEvery;
          const elapsed = clock() - start;
          log(`  ${fmt(written)} / ${fmt(rows)} rows (${fmt((written / elapsed) * 1000)} rows/s)`);
        }
      })
      .catch((error: unknown): void => {
        failure ??= error;
      })
      .finally((): void => {
        inFlight.delete(task);
      });
    inFlight.add(task);
    if (inFlight.size >= maxInFlight) await Promise.race(inFlight);
    if (failure !== undefined) break;
  }
  await Promise.all(inFlight);
  if (failure !== undefined) throw failure instanceof Error ? failure : new Error(String(failure));

  const elapsedMs = clock() - start;
  const rowsPerSec = (written / elapsedMs) * 1000;
  log(`Seeded ${fmt(written)} rows in ${(elapsedMs / 1000).toFixed(1)}s (${fmt(rowsPerSec)} rows/s)`);
  return { skipped: false, existingRows, rowsWritten: written, elapsedMs, rowsPerSec };
}
