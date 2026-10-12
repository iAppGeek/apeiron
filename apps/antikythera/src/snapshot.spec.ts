import { BUCKETS, MemoryBus, type KvBucket, type KvEntry, type KvWatch, type Order } from '@apeiron/logos';
import { describe, expect, it, vi } from 'vitest';
import { loadSnapshot } from './snapshot.js';
import { ColumnarStore } from './store/columnar-store.js';
import { ensureBuckets, markProjection, publishRecord, recordOf, seedBucket } from './testing/bucket.js';
import { makeOrders } from './testing/orders.js';

const orders = makeOrders(Array.from({ length: 12 }, (_, i) => ({ status: i < 4 ? ('LIVE' as const) : ('FILLED' as const), filledQty: i * 1000 })));
const options = { markerPollMs: 2, retryMs: 5 };
const newStore = (): ColumnarStore => new ColumnarStore({ capacity: 4 });

describe('loadSnapshot', () => {
  it('loads every order from the bucket, puts them in ascending id order and keeps each version', async () => {
    const bus = new MemoryBus();
    await ensureBuckets(bus);
    // Published in the order they last changed, which is not id order, and at different versions.
    const shuffled = [orders[7], orders[2], orders[11], orders[0], orders[5], ...orders.filter((_, i) => ![7, 2, 11, 0, 5].includes(i))] as Order[];
    for (const [i, order] of shuffled.entries()) await publishRecord(bus, order, i + 1);
    await markProjection(bus, orders.length);
    const store = newStore();
    const { report } = await loadSnapshot({ bus, store, ...options });
    expect(report).toMatchObject({ rows: 12, expected: 12, skipped: 0 });
    expect(report.loadMs).toBeGreaterThanOrEqual(0);
    expect([...Array(store.size).keys()].map((r) => store.orderAt(r).orderId)).toEqual(orders.map((o) => o.orderId));
    expect(store.idsAscending).toBe(true);
    for (const [i, order] of shuffled.entries()) {
      const row = store.rowIndexOf(order.orderId) as number;
      expect(store.versionAt(row)).toBe(i + 1);
      expect(store.orderAt(row)).toEqual(order);
    }
    expect(store.stringRankState('clientOrderId')).not.toBeNull();
  });

  it('reads the initial values in batches', async () => {
    const bus = new MemoryBus();
    await seedBucket(bus, orders);
    const store = newStore();
    const append = vi.spyOn(store, 'appendBatch');
    await loadSnapshot({ bus, store, batchSize: 5, ...options });
    expect(append.mock.calls.map((c) => c[0].length)).toEqual([5, 5, 2]);
    expect(store.size).toBe(12);
  });

  it('waits until the projection marker says it is ready', async () => {
    const bus = new MemoryBus();
    await ensureBuckets(bus);
    for (const o of orders) await publishRecord(bus, o);
    await markProjection(bus, orders.length, false);
    const log = vi.fn();
    let done = false;
    const loading = loadSnapshot({ bus, store: newStore(), log, ...options }).then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(done).toBe(false);
    expect(log).toHaveBeenCalledWith('waiting for the order service to finish the projection', {});
    await markProjection(bus, orders.length);
    await loading;
    expect(done).toBe(true);
  });

  it('does not start before the buckets exist', async () => {
    const bus = new MemoryBus();
    let done = false;
    const loading = loadSnapshot({ bus, store: newStore(), ...options }).then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(done).toBe(false);
    await seedBucket(bus, orders);
    await loading;
    expect(done).toBe(true);
  });

  it('starts again with an empty store when the marker says ready but the bucket is empty', async () => {
    const bus = new MemoryBus();
    await ensureBuckets(bus);
    await markProjection(bus, 5);
    const log = vi.fn();
    const store = newStore();
    const loading = loadSnapshot({ bus, store, log, ...options });
    await new Promise((r) => setTimeout(r, 150));
    expect(log).toHaveBeenCalledWith('snapshot incomplete, starting again', { reason: expect.stringContaining('bucket is empty') });
    await seedBucket(bus, orders.slice(0, 5));
    const { report } = await loading;
    expect(report.rows).toBe(5);
    expect(store.size).toBe(5);
  });

  it('discards a half-built load and starts again when fewer orders arrive than the marker promised', async () => {
    const bus = new MemoryBus();
    await ensureBuckets(bus);
    for (const o of orders.slice(0, 6)) await publishRecord(bus, o);
    await markProjection(bus, 12);
    const log = vi.fn();
    const store = newStore();
    const loading = loadSnapshot({ bus, store, log, ...options });
    await new Promise((r) => setTimeout(r, 150));
    expect(log).toHaveBeenCalledWith('snapshot incomplete, starting again', { reason: expect.stringMatching(/received 6 orders.*promised 12/) });
    expect(store.size).toBe(0);
    for (const o of orders.slice(6)) await publishRecord(bus, o);
    const { report } = await loading;
    expect(report).toMatchObject({ rows: 12, expected: 12 });
    expect(store.size).toBe(12);
  });

  it('accepts a bucket that holds more orders than the marker counted', async () => {
    const bus = new MemoryBus();
    await seedBucket(bus, orders);
    await markProjection(bus, 8);
    const { report } = await loadSnapshot({ bus, store: newStore(), ...options });
    expect(report).toMatchObject({ rows: 12, expected: 8 });
  });

  it('skips delete markers and unreadable values and counts them', async () => {
    const bus = new MemoryBus();
    await seedBucket(bus, orders);
    const kv = bus.kv(BUCKETS.orderState);
    await kv.put('JUNK', { nonsense: true });
    await kv.put('GONE', recordOf(orders[0] as Order));
    await kv.delete('GONE');
    const store = newStore();
    const { report } = await loadSnapshot({ bus, store, ...options });
    expect(report).toMatchObject({ rows: 12, skipped: 2 });
    expect(store.rowIndexOf('JUNK')).toBeUndefined();
  });

  it('keeps the newer of two entries for one order, wherever the earlier one is', async () => {
    const bus = new MemoryBus();
    await seedBucket(bus, orders);
    await markProjection(bus, 3);
    const entry = (key: string, v: number, filledQty: number, delta: number, revision: number): KvEntry => ({
      key,
      value: recordOf({ ...(orders.find((o) => o.orderId === key) as Order), filledQty }, v),
      revision,
      op: 'PUT',
      isUpdate: false,
      delta,
    });
    const [a, b, c] = [orders[0], orders[1], orders[2]] as [Order, Order, Order];
    // Within a batch (a, then a again), across batches (b flushed, then b again), and an older copy that must lose.
    const script: KvEntry[] = [
      entry(a.orderId, 2, 20, 6, 1),
      entry(a.orderId, 3, 30, 5, 2),
      entry(b.orderId, 4, 40, 4, 3),
      entry(c.orderId, 1, 10, 3, 4),
      entry(b.orderId, 5, 50, 2, 5),
      entry(c.orderId, 0 + 1, 99, 1, 6),
      entry(a.orderId, 1, 1, 0, 7),
    ];
    const real = bus.kv.bind(bus);
    bus.kv = (name: string): KvBucket => {
      const kv = real(name);
      if (name !== BUCKETS.orderState) return kv;
      return {
        ...kv,
        watch: (): Promise<KvWatch> => {
          async function* generate(): AsyncGenerator<KvEntry> {
            yield* script;
          }
          return Promise.resolve({ [Symbol.asyncIterator]: generate, close: () => Promise.resolve() });
        },
      };
    };
    const store = newStore();
    await loadSnapshot({ bus, store, batchSize: 2, ...options });
    expect(store.size).toBe(3);
    expect([a, b, c].map((o) => [store.versionAt(store.rowIndexOf(o.orderId) as number), store.orderAt(store.rowIndexOf(o.orderId) as number).filledQty])).toEqual([
      [3, 30],
      [5, 50],
      [1, 10],
    ]);
  });

  it('hands over the open watch: later changes arrive as updates, after the initial values', async () => {
    const bus = new MemoryBus();
    await seedBucket(bus, orders);
    const snapshot = await loadSnapshot({ bus, store: newStore(), ...options });
    expect(snapshot.revision).toBeGreaterThan(0);
    const next = snapshot.entries.next();
    await publishRecord(bus, { ...(orders[3] as Order), filledQty: 777 }, 2);
    const step = await next;
    expect(step.done).toBe(false);
    expect(step.value).toMatchObject({ key: orders[3]?.orderId, isUpdate: true, op: 'PUT' });
    await snapshot.watch.close();
  });

  it('fails, rather than starts again, on an error that is not an incomplete snapshot', async () => {
    const bus = new MemoryBus();
    await seedBucket(bus, orders);
    const real = bus.kv.bind(bus);
    bus.kv = (name: string): KvBucket => ({ ...real(name), status: () => Promise.reject(new Error('nats down')) });
    await expect(loadSnapshot({ bus, store: newStore(), ...options })).rejects.toThrow('nats down');
  });
});
