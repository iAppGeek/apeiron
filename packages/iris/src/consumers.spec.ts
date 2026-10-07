import { AckPolicy, DeliverPolicy } from '@nats-io/jetstream';
import { describe, expect, it, vi } from 'vitest';
import { durableConsumerConfig, ensureConsumer, type ConsumerManager } from './consumers.js';

const spec = { stream: 'ORDERS', durable: 'blotter-server', subject: 'orders.events' };

function manager(info: () => Promise<{ config: { ack_policy?: AckPolicy } }>): ConsumerManager {
  return {
    consumers: {
      info: vi.fn(info),
      add: vi.fn(() => Promise.resolve({})),
      update: vi.fn(() => Promise.resolve({})),
      delete: vi.fn(() => Promise.resolve(true)),
      reset: vi.fn(() => Promise.resolve({})),
    },
  };
}

describe('durableConsumerConfig', () => {
  it('filters one subject, acknowledges cumulatively and starts from the beginning of the stream', () => {
    expect(durableConsumerConfig(spec)).toMatchObject({
      durable_name: 'blotter-server',
      filter_subject: 'orders.events',
      ack_policy: AckPolicy.All,
      deliver_policy: DeliverPolicy.All,
    });
  });
});

describe('ensureConsumer', () => {
  it('creates a missing consumer', async () => {
    const m = manager(() => Promise.reject(new Error('consumer not found')));
    expect(await ensureConsumer(m, spec)).toBe('created');
    expect(m.consumers.add).toHaveBeenCalledWith('ORDERS', expect.objectContaining({ durable_name: 'blotter-server' }));
  });

  it('updates the timing of an existing consumer with the right ack policy', async () => {
    const m = manager(() => Promise.resolve({ config: { ack_policy: AckPolicy.All } }));
    expect(await ensureConsumer(m, spec)).toBe('updated');
    expect(m.consumers.update).toHaveBeenCalled();
    expect(m.consumers.reset).toHaveBeenCalledWith('ORDERS', 'blotter-server');
    expect(m.consumers.add).not.toHaveBeenCalled();
  });

  it('deletes and recreates a consumer whose ack policy cannot be edited', async () => {
    const m = manager(() => Promise.resolve({ config: { ack_policy: AckPolicy.Explicit } }));
    expect(await ensureConsumer(m, spec)).toBe('recreated');
    expect(m.consumers.delete).toHaveBeenCalledWith('ORDERS', 'blotter-server');
    expect(m.consumers.add).toHaveBeenCalledTimes(1);
  });
});
