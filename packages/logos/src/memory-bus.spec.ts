import { describe, expect, it, vi } from 'vitest';
import { MemoryBus, subjectMatches } from './memory-bus.js';

describe('subjectMatches', () => {
  it('matches literals, single-token and tail wildcards', () => {
    expect(subjectMatches('orders.events', 'orders.events')).toBe(true);
    expect(subjectMatches('prices.*', 'prices.EURUSD')).toBe(true);
    expect(subjectMatches('prices.*', 'prices.EURUSD.x')).toBe(false);
    expect(subjectMatches('prices.*', 'orders.events')).toBe(false);
    expect(subjectMatches('prices.>', 'prices.EURUSD.x')).toBe(true);
    expect(subjectMatches('orders.events', 'orders')).toBe(false);
  });
});

describe('MemoryBus', () => {
  it('delivers to matching subscribers with a cloned payload', async () => {
    const bus = new MemoryBus();
    const handler = vi.fn();
    await bus.subscribe('prices.*', handler);
    const payload = { a: 1 };
    await bus.publish('prices.EURUSD', payload);
    await bus.publish('orders.events', {});
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toEqual({ a: 1 });
    expect(handler.mock.calls[0]?.[0]).not.toBe(payload);
    expect(handler.mock.calls[0]?.[1]).toBe('prices.EURUSD');
  });

  it('stops delivering after a subscription closes', async () => {
    const bus = new MemoryBus();
    const handler = vi.fn();
    const sub = await bus.subscribe('control.load', handler);
    await sub.close();
    await bus.publish('control.load', {});
    expect(handler).not.toHaveBeenCalled();
  });

  it('stores stream subjects and replays unacked messages to a returning durable consumer', async () => {
    const bus = new MemoryBus();
    await bus.publish('orders.events', { n: 1 });
    await bus.publish('orders.events', { n: 2 });
    await bus.publish('control.load', { n: 99 });
    expect(bus.streamLog('ORDERS')).toHaveLength(2);

    const first: number[] = [];
    const sub = await bus.consume({ stream: 'ORDERS', durable: 'd', subject: 'orders.events' }, (p, _s, ack) => {
      first.push((p as { n: number }).n);
      if (first.length === 1) ack();
    });
    expect(first).toEqual([1, 2]);
    await sub.close();

    await bus.publish('orders.events', { n: 3 });
    const second: number[] = [];
    await bus.consume({ stream: 'ORDERS', durable: 'd', subject: 'orders.events' }, (p, _s, ack) => {
      second.push((p as { n: number }).n);
      ack();
    });
    expect(second).toEqual([2, 3]);
  });

  it('delivers live messages to an active consumer and rejects unknown streams', async () => {
    const bus = new MemoryBus();
    const seen: unknown[] = [];
    await bus.consume({ stream: 'ORDERS', durable: 'x', subject: 'orders.events' }, (p) => seen.push(p));
    await bus.publish('orders.events', { n: 1 });
    expect(seen).toEqual([{ n: 1 }]);
    await expect(bus.consume({ stream: 'NOPE', durable: 'y', subject: 'a' }, () => undefined)).rejects.toThrow();
  });

  it('ignores publishes after close', async () => {
    const bus = new MemoryBus();
    const handler = vi.fn();
    await bus.subscribe('a', handler);
    await bus.close();
    await bus.publish('a', {});
    expect(handler).not.toHaveBeenCalled();
  });
});
