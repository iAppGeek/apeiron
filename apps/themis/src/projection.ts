import { randomUUID } from 'node:crypto';
import { PROJECTION_KEY, parseOrderStateRecord, parseProjectionMarker, type KvBucket, type OrderStateRecord, type ProjectionMarker } from '@apeiron/logos';
import type { OrderRepository, StoredOrder } from '@apeiron/mnemosyne';
import { toStateRecord } from './committer.js';

export type ProjectionLogger = {
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
};

export type ProjectionDeps = {
  repo: OrderRepository;
  /** `ORDER_STATE`. */
  state: KvBucket;
  /** `ORDER_STATE_META`. */
  meta: KvBucket;
  log: ProjectionLogger;
  now?: () => number;
};

/** Puts in flight at once while rebuilding. */
export const REBUILD_CONCURRENCY = 1_000;

/** The record a database row publishes when nothing newer is known: `srcTs` is the order's own last update. */
export const recordOf = (stored: StoredOrder): OrderStateRecord => toStateRecord(stored, stored.order.lastUpdateTime);

async function readMarker(meta: KvBucket): Promise<ProjectionMarker | null> {
  const entry = await meta.get(PROJECTION_KEY);
  if (entry === null) return null;
  const parsed = parseProjectionMarker(entry.value);
  return parsed.ok ? parsed.value : null;
}

/** Why the projection needs rebuilding, or null when it looks complete. */
export async function rebuildReason(deps: Pick<ProjectionDeps, 'repo' | 'state' | 'meta'>, forced: boolean): Promise<string | null> {
  if (forced) return 'REBUILD_PROJECTION is set';
  const marker = await readMarker(deps.meta);
  if (marker === null) return 'no projection marker';
  if (!marker.ready) return 'the projection marker is not ready';
  const [values, count] = [(await deps.state.status()).values, await deps.repo.count()];
  if (values !== count) return `the bucket holds ${values} values but the database ${count} orders`;
  return null;
}

/**
 * Makes sure `ORDER_STATE` holds every order and says so in the marker. A rebuild writes the marker as not ready,
 * streams every order into the bucket, then writes it ready with the count and a fresh epoch. It never deletes
 * keys, and a record with a higher `v` than the database row is left alone. Returns the rows written, or null
 * when no rebuild was needed.
 */
export async function ensureProjection(deps: ProjectionDeps, forced: boolean): Promise<{ count: number; seconds: number } | null> {
  const reason = await rebuildReason(deps, forced);
  if (reason === null) {
    deps.log.info({}, 'projection is complete');
    return null;
  }
  const now = deps.now ?? ((): number => Date.now());
  deps.log.info({ reason }, 'rebuilding the projection');
  const started = performance.now();
  await deps.meta.put(PROJECTION_KEY, { ready: false, count: 0, epoch: '', builtAt: now() } satisfies ProjectionMarker);
  let count = 0;
  for await (const batch of deps.repo.loadAll()) {
    for (let i = 0; i < batch.length; i += REBUILD_CONCURRENCY) {
      await Promise.all(batch.slice(i, i + REBUILD_CONCURRENCY).map((stored) => deps.state.put(stored.order.orderId, recordOf(stored))));
    }
    count += batch.length;
  }
  await deps.meta.put(PROJECTION_KEY, { ready: true, count, epoch: randomUUID(), builtAt: now() } satisfies ProjectionMarker);
  const seconds = (performance.now() - started) / 1000;
  deps.log.info({ count, seconds }, 'projection rebuilt');
  return { count, seconds };
}

const CHECK_CONCURRENCY = 100;

/**
 * Startup reconciliation after a possible crash between a database write and its KV put: for the open orders and
 * for orders updated in the last `windowMs`, compares the row's `v` with the one in the bucket and republishes
 * any that differ. Returns how many were republished.
 */
export async function reconcileProjection(deps: ProjectionDeps, windowMs: number): Promise<number> {
  const now = deps.now ?? ((): number => Date.now());
  const seen = new Set<string>();
  let republished = 0;
  const check = async (batch: StoredOrder[]): Promise<void> => {
    const fresh = batch.filter((s) => !seen.has(s.order.orderId));
    for (const s of fresh) seen.add(s.order.orderId);
    for (let i = 0; i < fresh.length; i += CHECK_CONCURRENCY) {
      await Promise.all(
        fresh.slice(i, i + CHECK_CONCURRENCY).map(async (stored) => {
          const entry = await deps.state.get(stored.order.orderId);
          const parsed = entry === null ? null : parseOrderStateRecord(entry.value);
          const have = parsed !== null && parsed.ok ? parsed.value.v : null;
          if (have === stored.v) return;
          await deps.state.put(stored.order.orderId, recordOf(stored));
          republished++;
        }),
      );
    }
  };
  await check(await deps.repo.loadOpen());
  for await (const batch of deps.repo.loadUpdatedSince(now() - windowMs)) await check(batch);
  if (republished > 0) deps.log.warn({ republished }, 'republished orders the projection was missing');
  return republished;
}
