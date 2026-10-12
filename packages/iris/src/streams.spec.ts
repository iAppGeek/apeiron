import { RetentionPolicy, StorageType } from '@nats-io/jetstream';
import { describe, expect, it, vi } from 'vitest';
import { ensureStreams, streamSpecs, type StreamManager } from './streams.js';

const DAY_NS = 24 * 3_600_000 * 1_000_000;

function manager(existing: Record<string, Record<string, unknown>>): StreamManager {
  return {
    streams: {
      info: vi.fn((name: string) => {
        const config = existing[name];
        if (config === undefined) {
          const error = new Error('stream not found');
          error.name = 'StreamNotFoundError';
          return Promise.reject(error);
        }
        return Promise.resolve({ config });
      }),
      add: vi.fn(() => Promise.resolve({})),
      update: vi.fn(() => Promise.resolve({})),
      delete: vi.fn(() => Promise.resolve({})),
    },
  };
}

describe('streamSpecs', () => {
  it('defines PRICES on prices.* with one message per subject', () => {
    const [prices] = streamSpecs();
    expect(prices).toMatchObject({ name: 'PRICES', subjects: ['prices.*'], retention: RetentionPolicy.Limits, max_msgs_per_subject: 1 });
  });
});

describe('ensureStreams', () => {
  const existing = (): Record<string, Record<string, unknown>> => {
    const [prices, exec, venue] = streamSpecs();
    return { PRICES: { ...prices }, EXEC: { ...exec }, VENUE: { ...venue } };
  };

  it('creates missing streams', async () => {
    const m = manager({});
    const results = await ensureStreams(m);
    expect(results).toEqual([
      { name: 'PRICES', action: 'created' },
      { name: 'EXEC', action: 'created' },
      { name: 'VENUE', action: 'created' },
    ]);
    expect(m.streams.add).toHaveBeenCalledTimes(3);
    expect(m.streams.update).not.toHaveBeenCalled();
  });

  it('leaves matching streams alone', async () => {
    const have = existing();
    have['PRICES'] = { ...have['PRICES'], extra: 1 };
    const m = manager(have);
    expect(await ensureStreams(m)).toEqual([
      { name: 'PRICES', action: 'unchanged' },
      { name: 'EXEC', action: 'unchanged' },
      { name: 'VENUE', action: 'unchanged' },
    ]);
    expect(m.streams.add).not.toHaveBeenCalled();
    expect(m.streams.update).not.toHaveBeenCalled();
  });

  it('updates a stream whose configuration differs, keeping unrelated settings', async () => {
    const have = existing();
    have['EXEC'] = { ...have['EXEC'], max_age: 1, num_replicas: 1 };
    const m = manager(have);
    const results = await ensureStreams(m);
    expect(results[1]).toEqual({ name: 'EXEC', action: 'updated' });
    expect(m.streams.update).toHaveBeenCalledTimes(1);
    expect(m.streams.update).toHaveBeenCalledWith('EXEC', expect.objectContaining({ max_age: DAY_NS, num_replicas: 1 }));
  });

  it('can ensure just the streams it is given', async () => {
    const m = manager({});
    expect(await ensureStreams(m, streamSpecs().filter((s) => s.name === 'PRICES'))).toEqual([{ name: 'PRICES', action: 'created' }]);
  });

  it('recreates a stream whose storage type differs, since that cannot be changed in place', async () => {
    const have = existing();
    have['PRICES'] = { ...have['PRICES'], storage: StorageType.Memory };
    const m = manager(have);
    expect(await ensureStreams(m)).toEqual([
      { name: 'PRICES', action: 'recreated' },
      { name: 'EXEC', action: 'unchanged' },
      { name: 'VENUE', action: 'unchanged' },
    ]);
    expect(m.streams.delete).toHaveBeenCalledWith('PRICES');
    expect(m.streams.add).toHaveBeenCalledWith(expect.objectContaining({ name: 'PRICES', storage: StorageType.File }));
    expect(m.streams.update).not.toHaveBeenCalled();
  });

  it('rethrows unexpected errors', async () => {
    const m = manager({});
    m.streams.info = vi.fn(() => Promise.reject(new Error('boom')));
    await expect(ensureStreams(m)).rejects.toThrow('boom');
  });
});
