import { MemoryBus, type Order } from '@apeiron/logos';
import { InMemoryOrderRepository } from '@apeiron/mnemosyne';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer, type BlotterServer } from '../server.js';
import { LiveClient, flatRequest, groupedRequest, measureDefaultView, measureGroupedView, median, percentile } from './live-client.js';
import { makeOrders } from './orders.js';

const ROWS = makeOrders(
  Array.from({ length: 30 }, (_, i) => ({
    status: 'LIVE' as const,
    currencyPair: i % 2 === 0 ? ('EURUSD' as const) : ('GBPUSD' as const),
    side: 'BUY' as const,
    createdAt: 1_000 + i,
    orderQty: 1_000_000,
    filledQty: 100_000,
    remainingQty: 900_000,
    avgFillPrice: 1.08,
    arrivalPrice: 1.08,
    notionalUsd: 1_080_000,
  })),
);

let server: BlotterServer | null = null;
afterEach(async () => {
  await server?.app.close();
  server = null;
});

async function start(): Promise<{ bus: MemoryBus; url: string }> {
  const bus = new MemoryBus();
  const repo = new InMemoryOrderRepository();
  await repo.upsertMany(ROWS);
  server = await buildServer({ repo, bus, logLevel: 'silent', storeCapacity: 64, flushMs: 20, writeBehindMs: 50, summaryIntervalMs: 100 });
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  await server.load();
  const addr = server.app.server.address();
  return { bus, url: `ws://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}/ws` };
}

describe('statistics helpers', () => {
  it('computes percentiles and medians, tolerating empty input', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 99)).toBe(10);
    expect(median([9, 1, 5])).toBe(5);
  });

  it('builds the requests the report uses', () => {
    expect(flatRequest(0, 50)).toMatchObject({ startRow: 0, endRow: 50, rowGroupCols: [] });
    expect(groupedRequest(['LIVE'])).toMatchObject({ groupKeys: ['LIVE'], rowGroupCols: [{ id: 'status' }] });
  });
});

describe('LiveClient and the measurements', () => {
  it('measures tick rates, adds and the summary on the default view', async () => {
    const { bus, url } = await start();
    const client = await LiveClient.connect(url);
    let n = 0;
    const feed = setInterval(() => {
      for (const [pair, mid] of [['EURUSD', 1.08], ['GBPUSD', 1.27]] as const) {
        n++;
        void bus.publish(`prices.${pair}`, { pair, bid: mid + n * 1e-5, ask: mid + n * 1e-5 + 2e-4, ts: n });
      }
      const order: Order = { ...(ROWS[0] as Order), orderId: `T${String(5_000 + n).padStart(7, '0')}`, createdAt: 10_000 + n };
      if (n % 4 === 0) void bus.publish('orders.events', { type: 'NEW', order, ts: n });
    }, 40);
    const report = await measureDefaultView(client, 1.2);
    clearInterval(feed);
    expect(report.trackedLiveRows).toBe(30);
    expect(report.deltas).toBeGreaterThan(5);
    expect(report.liveRowTicksPerSecMedian).toBeGreaterThan(5);
    expect(report.adds).toBeGreaterThan(0);
    expect(report.allAddsAtIndexZero).toBe(true);
    expect(report.summary?.byStatus.LIVE).toBeGreaterThanOrEqual(30);
    expect(report.deltaLatencyMs.p99).toBeLessThan(1_000);
    await client.close();
  });

  it('measures group updates and row counts on a grouped view', async () => {
    const { bus, url } = await start();
    const client = await LiveClient.connect(url);
    let n = 0;
    const feed = setInterval(() => {
      n++;
      void bus.publish('prices.EURUSD', { pair: 'EURUSD', bid: 1.08 + n * 1e-5, ask: 1.0802 + n * 1e-5, ts: n });
      void bus.publish('orders.events', { type: 'UPDATE', order: { orderId: 'T0000001', filledQty: 100_000 + n * 1000, remainingQty: 900_000 - n * 1000 }, ts: n });
      if (n === 3) void bus.publish('orders.events', { type: 'UPDATE', order: { orderId: 'T0000003', status: 'PAUSED' }, ts: n });
    }, 40);
    const report = await measureGroupedView(client, 1.2);
    clearInterval(feed);
    expect(report.rootGroups).toBe(1);
    expect(report.groupUpdateMessages).toBeGreaterThan(0);
    expect(report.sampleGroupUpdate).toHaveProperty('childCount');
    expect(report.rowCountMessages).toBeGreaterThan(0);
    await client.close();
  });

  it('rejects a getRows the server refuses', async () => {
    const { url } = await start();
    const client = await LiveClient.connect(url);
    await expect(client.getRows({ ...flatRequest(), pivotMode: true })).rejects.toThrow('UNSUPPORTED_PIVOT');
    await client.close();
  });
});
