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
    // Acking the first message acknowledges it; the second stays pending and is redelivered.

    await bus.publish('orders.events', { n: 3 });
    const second: number[] = [];
    await bus.consume({ stream: 'ORDERS', durable: 'd', subject: 'orders.events' }, (p, _s, ack) => {
      second.push((p as { n: number }).n);
      ack();
    });
    expect(second).toEqual([2, 3]);
  });

  it('treats an ack as covering every earlier message (AckPolicy.All)', async () => {
    const bus = new MemoryBus();
    for (const n of [1, 2, 3]) await bus.publish('orders.events', { n });
    const sub = await bus.consume({ stream: 'ORDERS', durable: 'all', subject: 'orders.events' }, (p, _s, ack) => {
      if ((p as { n: number }).n === 2) ack();
    });
    await sub.close();
    const again: number[] = [];
    await bus.consume({ stream: 'ORDERS', durable: 'all', subject: 'orders.events' }, (p) => again.push((p as { n: number }).n));
    expect(again).toEqual([3]);
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

describe('MemoryBus request/reply', () => {
  it('answers a request with the handler result, cloning both directions', async () => {
    const bus = new MemoryBus();
    await bus.serve('orders.cmd', (payload) => ({ got: payload }));
    const sent = { a: 1 };
    const reply = (await bus.request('orders.cmd', sent, 100)) as { got: unknown };
    expect(reply).toEqual({ got: { a: 1 } });
    expect(reply.got).not.toBe(sent);
  });

  it('supports async handlers and wildcard subjects', async () => {
    const bus = new MemoryBus();
    await bus.serve('ref.*', async (_p, subject) => Promise.resolve(subject));
    expect(await bus.request('ref.mids', null, 100)).toBe('ref.mids');
  });

  it('rejects when nobody serves the subject', async () => {
    await expect(new MemoryBus().request('orders.cmd', {}, 100)).rejects.toThrow(/No responders/);
  });

  it('rejects when the handler throws', async () => {
    const bus = new MemoryBus();
    await bus.serve('orders.cmd', () => {
      throw new Error('boom');
    });
    await expect(bus.request('orders.cmd', {}, 100)).rejects.toThrow('boom');
  });

  it('rejects after the timeout when the handler never answers', async () => {
    vi.useFakeTimers();
    try {
      const bus = new MemoryBus();
      await bus.serve('orders.cmd', () => new Promise(() => undefined));
      const result = expect(bus.request('orders.cmd', {}, 50)).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(60);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops serving after the subscription closes', async () => {
    const bus = new MemoryBus();
    const sub = await bus.serve('orders.cmd', () => 1);
    await sub.close();
    await expect(bus.request('orders.cmd', {}, 100)).rejects.toThrow(/No responders/);
  });
});

describe('MemoryBus lastPerSubject', () => {
  it('returns the latest message of every matching subject', async () => {
    const bus = new MemoryBus();
    await bus.publish('prices.EURUSD', { n: 1 });
    await bus.publish('prices.GBPUSD', { n: 2 });
    await bus.publish('prices.EURUSD', { n: 3 });
    await bus.publish('orders.events', { n: 4 });
    const last = await bus.lastPerSubject('PRICES', 'prices.*');
    expect(last.sort((a, b) => a.subject.localeCompare(b.subject))).toEqual([
      { subject: 'prices.EURUSD', payload: { n: 3 } },
      { subject: 'prices.GBPUSD', payload: { n: 2 } },
    ]);
    expect(await bus.lastPerSubject('PRICES', 'prices.USDJPY')).toEqual([]);
  });

  it('rejects for an unknown stream', async () => {
    await expect(new MemoryBus().lastPerSubject('NOPE', '>')).rejects.toThrow(/Unknown stream/);
  });
});

describe('MemoryBus kv', () => {
  const config = { history: 1, storage: 'file' } as const;
  const take = async (watch: AsyncIterable<unknown>, n: number): Promise<unknown[]> => {
    const out: unknown[] = [];
    for await (const e of watch) {
      out.push(e);
      if (out.length === n) break;
    }
    return out;
  };

  it('fails until the bucket is ensured', async () => {
    const kv = new MemoryBus().kv('B');
    await expect(kv.put('a', 1)).rejects.toThrow(/not found/);
    await expect(kv.status()).rejects.toThrow(/not found/);
  });

  it('stores, replaces and gets values with increasing revisions', async () => {
    const kv = new MemoryBus().kv('B');
    await kv.ensure(config);
    expect(await kv.get('a')).toBeNull();
    const r1 = await kv.put('a', { n: 1 });
    const r2 = await kv.put('a', { n: 2 });
    expect(r2).toBeGreaterThan(r1);
    expect(await kv.get('a')).toMatchObject({ key: 'a', value: { n: 2 }, revision: r2, op: 'PUT' });
    expect(await kv.status()).toEqual({ values: 1 });
  });

  it('shares a bucket between handles of the same bus, and ensure keeps existing data', async () => {
    const bus = new MemoryBus();
    await bus.kv('B').ensure(config);
    await bus.kv('B').put('a', 1);
    await bus.kv('B').ensure(config);
    expect((await bus.kv('B').get('a'))?.value).toBe(1);
  });

  it('watch delivers the initial values (delta counts down to 0), then live updates', async () => {
    const kv = new MemoryBus().kv('B');
    await kv.ensure(config);
    await kv.put('a', 1);
    await kv.put('b', 2);
    await kv.put('a', 3);
    const watch = await kv.watch();
    await kv.put('c', 4);
    const entries = (await take(watch, 3)) as { key: string; value: unknown; isUpdate: boolean; delta: number }[];
    await watch.close();
    expect(entries.map((e) => [e.key, e.value, e.isUpdate, e.delta])).toEqual([
      ['b', 2, false, 1],
      ['a', 3, false, 0],
      ['c', 4, true, 0],
    ]);
  });

  it('watch with updatesOnly skips existing values', async () => {
    const kv = new MemoryBus().kv('B');
    await kv.ensure(config);
    await kv.put('a', 1);
    const watch = await kv.watch({ updatesOnly: true });
    await kv.put('b', 2);
    const [entry] = (await take(watch, 1)) as { key: string; isUpdate: boolean }[];
    await watch.close();
    expect(entry).toMatchObject({ key: 'b', isUpdate: true });
  });

  it('watch on an empty bucket yields nothing until something is written, and close ends it', async () => {
    const kv = new MemoryBus().kv('B');
    await kv.ensure(config);
    const watch = await kv.watch();
    const first = take(watch, 1);
    await kv.put('a', 1);
    expect(await first).toHaveLength(1);
    await watch.close();
    const ended = [];
    for await (const e of watch) ended.push(e);
    expect(ended).toEqual([]);
  });

  it('delete writes a marker that watchers see, and get no longer returns the key', async () => {
    const kv = new MemoryBus().kv('B');
    await kv.ensure(config);
    await kv.put('a', 1);
    const watch = await kv.watch({ updatesOnly: true });
    await kv.delete('a');
    const [entry] = (await take(watch, 1)) as unknown[];
    await watch.close();
    expect(entry).toMatchObject({ key: 'a', op: 'DEL', value: null, isUpdate: true });
    expect(await kv.get('a')).toBeNull();
  });

  it('clones values so callers cannot alias stored data', async () => {
    const kv = new MemoryBus().kv('B');
    await kv.ensure(config);
    const value = { n: 1 };
    await kv.put('a', value);
    value.n = 99;
    expect((await kv.get('a'))?.value).toEqual({ n: 1 });
  });

  it('close ends open watches', async () => {
    const bus = new MemoryBus();
    const kv = bus.kv('B');
    await kv.ensure(config);
    const watch = await kv.watch();
    const drained = (async (): Promise<number> => {
      let n = 0;
      for await (const _e of watch) n++;
      return n;
    })();
    await bus.close();
    expect(await drained).toBe(0);
  });
});
