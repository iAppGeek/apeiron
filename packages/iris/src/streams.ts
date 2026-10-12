import { DiscardPolicy, RetentionPolicy, StorageType, type StreamConfig } from '@nats-io/jetstream';
import { nanos } from '@nats-io/transport-node';
import { STREAMS, SUBJECTS } from '@apeiron/logos';

const HOUR_MS = 3_600_000;

/** Largest the ORDERS stream may grow; a safety cap on top of the 24h age limit (stress produces about 1MB/s). */
export const ORDERS_MAX_BYTES = 1024 * 1024 * 1024;

/** Largest the EXEC and VENUE streams may grow, on top of their 24h age limit. */
export const EXEC_MAX_BYTES = 1024 * 1024 * 1024;

export type StreamSpec = Pick<
  StreamConfig,
  'name' | 'subjects' | 'retention' | 'storage' | 'discard' | 'max_age' | 'max_msgs_per_subject' | 'max_bytes'
>;

/**
 * The JetStream streams of Appendix C: ORDERS captures `orders.*` (limits retention, 24h) and
 * PRICES captures `prices.*` and keeps one message per subject, so a late joiner can read the last quote. PRICES is on
 * file storage, so the last quote (and so the price feed's starting level) survives a restart of the broker.
 */
export function streamSpecs(): StreamSpec[] {
  return [
    {
      name: STREAMS.orders,
      subjects: ['orders.*'],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      discard: DiscardPolicy.Old,
      max_age: nanos(24 * HOUR_MS),
      max_msgs_per_subject: -1,
      max_bytes: ORDERS_MAX_BYTES,
    },
    {
      name: STREAMS.prices,
      subjects: ['prices.*'],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      discard: DiscardPolicy.Old,
      max_age: 0,
      max_msgs_per_subject: 1,
      max_bytes: -1,
    },
    {
      // Execution reports from the venue to the order service (durable consumer `themis-exec`).
      name: STREAMS.exec,
      subjects: [SUBJECTS.execReports],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      discard: DiscardPolicy.Old,
      max_age: nanos(24 * HOUR_MS),
      max_msgs_per_subject: -1,
      max_bytes: EXEC_MAX_BYTES,
    },
    {
      // Instructions from the order service to the venue (durable consumer `hermes-venue`).
      name: STREAMS.venue,
      subjects: [SUBJECTS.execCommands],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      discard: DiscardPolicy.Old,
      max_age: nanos(24 * HOUR_MS),
      max_msgs_per_subject: -1,
      max_bytes: EXEC_MAX_BYTES,
    },
  ];
}

/** The part of the JetStream manager `ensureStreams` needs, so it can be tested without a server. */
export type StreamManager = {
  streams: {
    info(name: string): Promise<{ config: Partial<StreamConfig> & Record<string, unknown> }>;
    add(config: Partial<StreamConfig>): Promise<unknown>;
    update(name: string, config: Partial<StreamConfig>): Promise<unknown>;
    delete(name: string): Promise<unknown>;
  };
};

export type EnsureResult = { name: string; action: 'created' | 'updated' | 'recreated' | 'unchanged' };

const isMissing = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'StreamNotFoundError' || /stream not found/i.test(error.message));

const differs = (have: Record<string, unknown>, want: StreamSpec): boolean =>
  (Object.keys(want) as (keyof StreamSpec)[]).some(
    (key) => JSON.stringify(have[key]) !== JSON.stringify(want[key]),
  );

/**
 * Creates the streams when missing and updates their configuration when it differs from
 * {@link streamSpecs}. Idempotent; safe to call on every start. Hermes owns stream creation.
 */
export async function ensureStreams(
  manager: StreamManager,
  specs: readonly StreamSpec[] = streamSpecs(),
): Promise<EnsureResult[]> {
  const results: EnsureResult[] = [];
  for (const spec of specs) {
    let existing: Record<string, unknown> | null = null;
    try {
      existing = (await manager.streams.info(spec.name)).config;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (existing === null) {
      await manager.streams.add(spec);
      results.push({ name: spec.name, action: 'created' });
    } else if (existing['storage'] !== undefined && spec.storage !== undefined && existing['storage'] !== spec.storage) {
      // The storage type of a stream cannot be changed in place. Only streams whose contents can be lost without harm
      // (the last price of each pair) are listed in specs this way, so it is deleted and made again.
      await manager.streams.delete(spec.name);
      await manager.streams.add(spec);
      results.push({ name: spec.name, action: 'recreated' });
    } else if (differs(existing, spec)) {
      await manager.streams.update(spec.name, { ...existing, ...spec } as Partial<StreamConfig>);
      results.push({ name: spec.name, action: 'updated' });
    } else {
      results.push({ name: spec.name, action: 'unchanged' });
    }
  }
  return results;
}
