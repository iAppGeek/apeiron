import { InMemoryOrderRepository } from '@apeiron/mnemosyne';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeStore } from '../testing/orders.js';
import { LiveStore } from './live-store.js';
import { WRITE_CHUNK, WriteBehind } from './write-behind.js';

const log = { warn: vi.fn(), error: vi.fn() };

function setup(): { live: LiveStore; repo: InMemoryOrderRepository; wb: WriteBehind; id: string; flush: (n: number, fields: object) => void; ack: ReturnType<typeof vi.fn> } {
  const store = makeStore([{ status: 'LIVE', currencyPair: 'EURUSD', numFills: 0 }]);
  const live = new LiveStore(store, log);
  live.init();
  const repo = new InMemoryOrderRepository();
  const wb = new WriteBehind(live, repo, log, 500);
  const id = store.orderAt(0).orderId;
  const ack = vi.fn();
  return {
    live,
    repo,
    wb,
    id,
    ack,
    flush: (n, fields): void => {
      live.enqueueEvent({ type: 'UPDATE', order: { orderId: id, numFills: n, ...fields }, ts: 1 }, ack);
      live.flush(1_000 + n);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('WriteBehind', () => {
  it('persists dirty rows and acknowledges only after the write', async () => {
    const h = setup();
    h.flush(3, {});
    let acked = false;
    h.ack.mockImplementation(() => {
      acked = true;
    });
    const upsert = vi.spyOn(h.repo, 'upsertMany').mockImplementation(async (orders) => {
      expect(acked).toBe(false);
      await InMemoryOrderRepository.prototype.upsertMany.call(h.repo, orders);
    });
    await h.wb.flush();
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(acked).toBe(true);
    expect(h.wb.stats).toMatchObject({ passes: 1, ordersWritten: 1, failures: 0 });
    const [stored] = (await collect(h.repo)).filter((o) => o.orderId === h.id);
    expect(stored?.numFills).toBe(3);
  });

  it('writes nothing for price-only changes but still acknowledges events that changed nothing durable', async () => {
    const h = setup();
    h.live.enqueueTick({ pair: 'EURUSD', bid: 1.1, ask: 1.1002, ts: 1 });
    h.live.flush(5_000);
    const upsert = vi.spyOn(h.repo, 'upsertMany');
    await h.wb.flush();
    expect(upsert).not.toHaveBeenCalled();
    h.flush(0, {});
    await h.wb.flush();
    expect(upsert).not.toHaveBeenCalled();
    expect(h.ack).toHaveBeenCalledTimes(1);
  });

  it('keeps the batch and the ack when the write fails, then succeeds on retry', async () => {
    const h = setup();
    h.flush(5, {});
    const upsert = vi.spyOn(h.repo, 'upsertMany').mockRejectedValueOnce(new Error('mongo down'));
    await h.wb.flush();
    expect(h.ack).not.toHaveBeenCalled();
    expect(h.wb.stats.failures).toBe(1);
    expect(log.error).toHaveBeenCalled();
    upsert.mockRestore();
    await h.wb.flush();
    expect(h.ack).toHaveBeenCalledTimes(1);
    expect((await collect(h.repo))[0]?.numFills).toBe(5);
  });

  it('reports batch size and duration on success and a failure on error', async () => {
    const store = makeStore([{ status: 'LIVE', currencyPair: 'EURUSD', numFills: 0 }]);
    const live = new LiveStore(store, log);
    live.init();
    const repo = new InMemoryOrderRepository();
    const writeBehind = vi.fn();
    const wb = new WriteBehind(live, repo, log, 500, { writeBehind });
    const id = store.orderAt(0).orderId;
    live.enqueueEvent({ type: 'UPDATE', order: { orderId: id, numFills: 1 }, ts: 1 }, vi.fn());
    live.flush(1_000);
    expect(live.dirtyCount).toBe(1);
    vi.spyOn(repo, 'upsertMany').mockRejectedValueOnce(new Error('down'));
    await wb.flush();
    expect(writeBehind).toHaveBeenLastCalledWith(expect.objectContaining({ batchSize: 1, ok: false }));
    await wb.flush();
    expect(writeBehind).toHaveBeenLastCalledWith(expect.objectContaining({ batchSize: 1, ok: true }));
    expect(live.dirtyCount).toBe(0);
  });

  it('writes a large backlog in bounded chunks and acknowledges only after the last one', async () => {
    const rows = Array.from({ length: WRITE_CHUNK * 2 + 5 }, () => ({ status: 'LIVE' as const, currencyPair: 'EURUSD' as const, numFills: 0 }));
    const store = makeStore(rows);
    const live = new LiveStore(store, log);
    live.init();
    const repo = new InMemoryOrderRepository();
    const ack = vi.fn();
    for (let i = 0; i < store.size; i++) live.enqueueEvent({ type: 'UPDATE', order: { orderId: store.orderAt(i).orderId, numFills: 1 }, ts: 1 }, ack);
    live.flush(1_000);
    const sizes: number[] = [];
    const acksSeen: number[] = [];
    vi.spyOn(repo, 'upsertMany').mockImplementation(async (orders) => {
      sizes.push(orders.length);
      acksSeen.push(ack.mock.calls.length);
    });
    await new WriteBehind(live, repo, log, 500).flush();
    expect(sizes).toEqual([WRITE_CHUNK, WRITE_CHUNK, 5]);
    expect(acksSeen).toEqual([0, 0, 0]);
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it('runs on its interval and stop() flushes what is left', async () => {
    vi.useFakeTimers();
    const h = setup();
    h.wb.start();
    h.flush(1, {});
    await vi.advanceTimersByTimeAsync(500);
    expect(h.wb.stats.passes).toBe(1);
    h.flush(2, {});
    await h.wb.stop();
    expect((await collect(h.repo))[0]?.numFills).toBe(2);
    expect(h.wb.stats.passes).toBe(2);
  });
});

async function collect(repo: InMemoryOrderRepository): Promise<{ orderId: string; numFills: number }[]> {
  const out: { orderId: string; numFills: number }[] = [];
  for await (const batch of repo.loadAll()) out.push(...batch);
  return out;
}
