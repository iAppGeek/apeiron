import { MemoryBus, sampleOrders, type ExecReport, type Order, type OrderStateRecord, type Row, type SsrmRequest } from '@apeiron/logos';
import { describe, expect, it } from 'vitest';
import type { Driver, VenueLog } from './driver';
import { OrderModel } from './model';
import { checkInvariants, checkMinimums, checkModelVsServer, checkServerVsScreen, checkVenueVsService, pool, type PageSnapshot } from './oracle';
import type { Reader } from './ws-client';

const order = (id: string, over: Partial<Order> = {}): Order =>
  ({
    orderId: id,
    currencyPair: 'EURUSD',
    side: 'BUY',
    status: 'LIVE',
    limitPrice: null,
    avgFillPrice: null,
    arrivalPrice: 1,
    filledQty: 0,
    orderQty: 100,
    notionalUsd: 100,
    numFills: 0,
    marketBid: 1,
    marketAsk: 1,
    marketMid: 1,
    spreadBps: 0,
    distanceToLimitBps: null,
    slippageBps: null,
    unrealisedPnlUsd: 0,
    lastUpdateTime: 1,
    ...over,
  }) as unknown as Order;

/** A reader over an in-memory table: sorted by orderId desc, with orderId-equals filters and one group level. */
function fakeReader(table: Row[], summary = { LIVE: 1 }): Reader {
  return {
    serverOffsetMs: 0,
    getRows: (req: SsrmRequest): Promise<{ rows: Row[]; rowCount: number }> => {
      let rows = [...table].sort((a, b) => String(b['orderId']).localeCompare(String(a['orderId'])));
      const f = req.filterModel?.['orderId'] as { filter?: string } | undefined;
      if (f?.filter !== undefined) rows = rows.filter((r) => r['orderId'] === f.filter);
      if (req.rowGroupCols.length > 0 && req.groupKeys.length === 0) {
        const groups = new Map<string, number>();
        for (const r of rows) groups.set(String(r['status']), (groups.get(String(r['status'])) ?? 0) + 1);
        const out = [...groups].map(([status, childCount]) => ({ status, childCount, notionalUsd: childCount * 100 }));
        return Promise.resolve({ rows: out.slice(req.startRow, req.endRow), rowCount: out.length });
      }
      if (req.groupKeys.length > 0) rows = rows.filter((r) => r['status'] === req.groupKeys[0]);
      return Promise.resolve({ rows: rows.slice(req.startRow, req.endRow), rowCount: rows.length });
    },
    nextSummary: () =>
      Promise.resolve({
        t: 'summary' as const,
        byStatus: { PENDING_START: 0, PAUSED: 0, FILLED: 0, CANCELLED: 0, LIVE: summary.LIVE },
        liveNotionalUsd: 100,
        totalRows: table.length,
        server: { cpu: 0, rssMb: 0, elLagMs: 0 },
        preset: null,
      }),
    close: (): void => undefined,
  };
}

const driverOf = (model: OrderModel, startMax: string | null): Driver => ({ model: () => model, startMaxOrderId: () => startMax }) as unknown as Driver;

describe('checkModelVsServer', () => {
  const initial = [order('ALG00000001', { status: 'FILLED' }), order('ALG00000002')];
  const records: OrderStateRecord[] = [
    { v: 1, execSeq: 0, srcTs: 1, order: order('ALG00000003') },
    { v: 2, execSeq: 1, srcTs: 2, order: order('ALG00000002', { filledQty: 10, numFills: 1 }) },
  ];
  const build = (): OrderModel => {
    const model = new OrderModel(initial);
    for (const r of records) model.applyRecord(r);
    return model;
  };

  it('passes when the server holds exactly what the model says, field for field', async () => {
    const model = build();
    const table = [
      order('ALG00000001', { status: 'FILLED' }),
      order('ALG00000002', { filledQty: 10, numFills: 1 }),
      order('ALG00000003'),
    ] as unknown as Row[];
    const check = await checkModelVsServer({ driver: driverOf(model, 'ALG00000002'), reader: fakeReader(table), baselineRowCount: 2 });
    expect(check.failures).toEqual([]);
    expect(check.ok).toBe(true);
    expect(check.stats['created']).toBe(1);
  });

  it('fails when only the update time differs: the blotter no longer writes it, so it must match', async () => {
    const model = build();
    const table = [
      order('ALG00000001', { status: 'FILLED' }),
      { ...order('ALG00000002', { filledQty: 10, numFills: 1 }), lastUpdateTime: 99 },
      order('ALG00000003'),
    ] as unknown as Row[];
    const check = await checkModelVsServer({ driver: driverOf(model, 'ALG00000002'), reader: fakeReader(table), baselineRowCount: 2 });
    expect(check.ok).toBe(false);
    expect(check.failures.join('\n')).toContain('lastUpdateTime');
  });

  it('fails on a lost update, a missing new order and a wrong row count', async () => {
    const model = build();
    const table = [order('ALG00000001', { status: 'FILLED' }), order('ALG00000002')] as unknown as Row[];
    const check = await checkModelVsServer({ driver: driverOf(model, 'ALG00000002'), reader: fakeReader(table), baselineRowCount: 2 });
    expect(check.ok).toBe(false);
    expect(check.failures.join('\n')).toContain('filledQty');
    expect(check.failures.join('\n')).toContain('ALG00000003');
    expect(check.failures.join('\n')).toContain('row count');
  });
});

describe('checkServerVsScreen', () => {
  const server = [order('ALG00000003'), order('ALG00000002'), order('ALG00000001', { status: 'FILLED' })] as unknown as Row[];
  const request: SsrmRequest = { startRow: 0, endRow: 100, rowGroupCols: [], valueCols: [], groupKeys: [], sortModel: [] };
  const flatSnapshot = (rows: Row[]): PageSnapshot => ({
    rows: rows.map((data, i) => ({ rowIndex: i, childIndex: i, id: String(data['orderId']), groupKeys: [], data })),
    groups: [],
    rootRowCount: 3,
    statusBarRowCount: 3,
    summary: { byStatus: { PENDING_START: 0, PAUSED: 0, FILLED: 0, CANCELLED: 0, LIVE: 1 }, liveNotionalUsd: 100, totalRows: 3 },
    view: { trader: 'ALL', codec: 'json', sort: [], filter: {}, grouping: [] },
    request,
    busy: false,
  });

  it('passes when every loaded row equals the server at the same position', async () => {
    const check = await checkServerVsScreen('V1', flatSnapshot(server), fakeReader(server));
    expect(check.failures).toEqual([]);
    expect(check.stats['leafRowsCompared']).toBe(3);
  });

  it('fails on a stale field, a misplaced row, a wrong count and wrong chips', async () => {
    const stale = server.map((r) => ({ ...r }));
    stale[1] = { ...stale[1], filledQty: 1 };
    const swapped = [stale[1] as Row, stale[0] as Row, stale[2] as Row];
    const snapshot = { ...flatSnapshot(swapped), rootRowCount: 4, summary: { ...(flatSnapshot(server).summary as NonNullable<PageSnapshot['summary']>), totalRows: 9 } };
    const check = await checkServerVsScreen('V1', snapshot, fakeReader(server));
    const text = check.failures.join('\n');
    expect(check.ok).toBe(false);
    expect(text).toContain('root row count');
    expect(text).toContain('summary chips');
    expect(text).toContain('the screen shows ALG00000002, the server has ALG00000003');
  });

  it('compares only contiguous runs and checks group rows by key', async () => {
    const grouped: PageSnapshot = {
      ...flatSnapshot([]),
      rows: [{ rowIndex: 5, childIndex: 0, id: 'x', groupKeys: ['LIVE'], data: server[0] as Row }, { rowIndex: 6, childIndex: 1, id: 'y', groupKeys: ['LIVE'], data: server[1] as Row }],
      groups: [
        { rowIndex: 4, childIndex: 0, id: 'G:LIVE', level: 0, key: 'LIVE', groupKeys: [], data: { status: 'LIVE', childCount: 2, notionalUsd: 200 } },
        { rowIndex: 7, childIndex: 1, id: 'G:FILLED', level: 0, key: 'FILLED', groupKeys: [], data: { status: 'FILLED', childCount: 5, notionalUsd: 100 } },
      ],
      rootRowCount: 2,
      statusBarRowCount: 2,
      request: { ...request, rowGroupCols: [{ id: 'status', field: 'status' }] },
    };
    const check = await checkServerVsScreen('V3', grouped, fakeReader(server));
    expect(check.stats['groupsCompared']).toBe(2);
    expect(check.failures.some((f) => f.includes('group FILLED') && f.includes('childCount'))).toBe(true);
    expect(check.failures.filter((f) => f.includes('group LIVE'))).toEqual([]);
    expect(check.stats['leafRowsCompared']).toBe(2);
  });

  it('reports a page that never sent a request, and a page that is still busy', async () => {
    const none = await checkServerVsScreen('V1', { ...flatSnapshot(server), request: null }, fakeReader(server));
    expect(none.ok).toBe(false);
    const busy = await checkServerVsScreen('V1', { ...flatSnapshot(server), busy: true }, fakeReader(server));
    expect(busy.failures[0]).toContain('still switching');
  });
});

describe('checkInvariants and checkMinimums', () => {
  it('fails on violations or an idle sampler', () => {
    expect(checkInvariants('V1', { samples: 10, ordersSeen: 5, violationCount: 0, violations: [], maxGapMs: 600 }).ok).toBe(true);
    const bad = checkInvariants('V1', {
      samples: 10,
      ordersSeen: 5,
      violationCount: 3,
      violations: [{ orderId: 'A', kind: 'filledQty', previous: 5, current: 1, atMs: 100 }],
      maxGapMs: 600,
    });
    expect(bad.ok).toBe(false);
    expect(bad.failures.join('\n')).toContain('filledQty went from 5 to 1');
    expect(checkInvariants('V1', { samples: 0, ordersSeen: 0, violationCount: 0, violations: [], maxGapMs: 0 }).ok).toBe(false);
  });

  it('fails a run below its minimums', () => {
    expect(checkMinimums('V1', { reconnects: 10, deltas: 500 }, { reconnects: 10, deltas: 100 }).ok).toBe(true);
    const low = checkMinimums('V1', { reconnects: 9, deltas: 5 }, { reconnects: 10, deltas: 100 });
    expect(low.ok).toBe(false);
    expect(low.failures).toHaveLength(2);
  });
});

describe('pool', () => {
  it('runs every item with bounded concurrency', async () => {
    let active = 0;
    let peak = 0;
    const done: number[] = [];
    await pool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      await Promise.resolve();
      done.push(n);
      active -= 1;
    });
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe('checkVenueVsService', () => {
  const start = (id: string): OrderStateRecord => ({
    v: 1,
    execSeq: 0,
    srcTs: 1,
    order: { ...(sampleOrders(1)[0] as Order), orderId: id, status: 'LIVE', orderQty: 1_000, remainingQty: 1_000, filledQty: 0, numFills: 0, notionalUsd: 1_000, filledNotionalUsd: 0, avgFillPrice: null, lastFillPrice: null, lastFillQty: 0 },
  });
  const quote = { bid: 1, ask: 1 };
  const fill = (orderId: string, execSeq: number, qty: number): ExecReport => ({ type: 'FILL', orderId, execSeq, qty, price: 1, ts: 10 + execSeq, ...quote });
  const logOf = (reports: ExecReport[], starts: OrderStateRecord[]): VenueLog => {
    const byOrder = new Map<string, ExecReport[]>();
    for (const r of reports) byOrder.set(r.orderId, [...(byOrder.get(r.orderId) ?? []), r]);
    return { reports: byOrder, startOf: (id) => starts.find((s) => s.order.orderId === id) };
  };
  /** Puts the record the service would store after `applied` fills into a bucket. */
  async function storedAfter(bus: MemoryBus, base: OrderStateRecord, fills: ExecReport[]): Promise<void> {
    const { applyExecReport } = await import('@apeiron/logos');
    let record = base;
    for (const f of fills) {
      const result = applyExecReport(record, f);
      if (result.kind !== 'duplicate') record = result.record;
    }
    await bus.kv('ORDER_STATE').put(base.order.orderId, record);
  }

  it('passes when the stored record is what replaying the venue`s reports gives, duplicates and all', async () => {
    const bus = new MemoryBus();
    await bus.kv('ORDER_STATE').ensure({ history: 1, storage: 'memory' });
    const a = start('A');
    const reports = [fill('A', 1, 100), fill('A', 2, 150), fill('A', 2, 150)];
    await storedAfter(bus, a, reports);
    const check = await checkVenueVsService({ log: logOf(reports, [a]), kv: bus.kv('ORDER_STATE') });
    expect(check.failures).toEqual([]);
    expect(check.ok).toBe(true);
    expect(check.stats).toMatchObject({ ordersCompared: 1, reports: 3 });
  });

  it('fails when the service lost a fill, applied one twice, or never stored the order', async () => {
    const bus = new MemoryBus();
    await bus.kv('ORDER_STATE').ensure({ history: 1, storage: 'memory' });
    const [a, b, c] = [start('A'), start('B'), start('C')] as [OrderStateRecord, OrderStateRecord, OrderStateRecord];
    const sent = [fill('A', 1, 100), fill('A', 2, 150), fill('B', 1, 100), fill('C', 1, 10)];
    await storedAfter(bus, a, [fill('A', 1, 100)]);
    await storedAfter(bus, b, [fill('B', 1, 100), fill('B', 2, 100)]);
    const check = await checkVenueVsService({ log: logOf(sent, [a, b, c]), kv: bus.kv('ORDER_STATE') });
    expect(check.ok).toBe(false);
    const text = check.failures.join('\n');
    expect(text).toContain('A after 2 reports');
    expect(text).toContain('filledQty');
    expect(text).toContain('B after 1 reports');
    expect(text).toContain('C: no readable record in ORDER_STATE');
  });

  it('fails an order it cannot replay because the start record is missing', async () => {
    const bus = new MemoryBus();
    await bus.kv('ORDER_STATE').ensure({ history: 1, storage: 'memory' });
    const check = await checkVenueVsService({ log: logOf([fill('Z', 1, 1)], []), kv: bus.kv('ORDER_STATE') });
    expect(check.failures).toEqual(['Z: no record before its first report, so it cannot be replayed']);
  });
});
