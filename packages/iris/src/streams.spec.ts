import { RetentionPolicy } from '@nats-io/jetstream';
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
    },
  };
}

describe('streamSpecs', () => {
  it('defines ORDERS on orders.* with 24h limits and PRICES on prices.* with one message per subject', () => {
    const [orders, prices] = streamSpecs();
    expect(orders).toMatchObject({ name: 'ORDERS', subjects: ['orders.*'], retention: RetentionPolicy.Limits, max_age: DAY_NS });
    expect(prices).toMatchObject({ name: 'PRICES', subjects: ['prices.*'], max_msgs_per_subject: 1 });
  });
});

describe('ensureStreams', () => {
  it('creates missing streams', async () => {
    const m = manager({});
    const results = await ensureStreams(m);
    expect(results).toEqual([
      { name: 'ORDERS', action: 'created' },
      { name: 'PRICES', action: 'created' },
    ]);
    expect(m.streams.add).toHaveBeenCalledTimes(2);
    expect(m.streams.update).not.toHaveBeenCalled();
  });

  it('leaves matching streams alone', async () => {
    const specs = streamSpecs();
    const m = manager({
      ORDERS: { ...specs[0], extra: 1 },
      PRICES: { ...specs[1] },
    });
    expect(await ensureStreams(m)).toEqual([
      { name: 'ORDERS', action: 'unchanged' },
      { name: 'PRICES', action: 'unchanged' },
    ]);
    expect(m.streams.add).not.toHaveBeenCalled();
    expect(m.streams.update).not.toHaveBeenCalled();
  });

  it('updates a stream whose configuration differs, keeping unrelated settings', async () => {
    const specs = streamSpecs();
    const m = manager({
      ORDERS: { ...specs[0], max_age: 1, num_replicas: 1 },
      PRICES: { ...specs[1] },
    });
    const results = await ensureStreams(m);
    expect(results[0]).toEqual({ name: 'ORDERS', action: 'updated' });
    expect(m.streams.update).toHaveBeenCalledTimes(1);
    expect(m.streams.update).toHaveBeenCalledWith('ORDERS', expect.objectContaining({ max_age: DAY_NS, num_replicas: 1 }));
  });

  it('rethrows unexpected errors', async () => {
    const m = manager({});
    m.streams.info = vi.fn(() => Promise.reject(new Error('boom')));
    await expect(ensureStreams(m)).rejects.toThrow('boom');
  });
});
