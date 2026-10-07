import type { Order, OrderEvent, Row, SsrmRequest } from '@apeiron/logos';
import { describe, expect, it } from 'vitest';
import type { Driver } from './driver';
import { OrderModel } from './model';
import { checkInvariants, checkMinimums, checkModelVsServer, checkServerVsScreen, pool, type PageSnapshot } from './oracle';
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
  const events: OrderEvent[] = [
    { type: 'NEW', order: order('ALG00000003'), ts: 1 },
    { type: 'UPDATE', order: { orderId: 'ALG00000002', filledQty: 10, numFills: 1 }, ts: 2 },
  ];
  const build = (): OrderModel => {
    const model = new OrderModel(initial);
    for (const e of events) model.applyEvent(e);
    return model;
  };

  it('passes when the server holds exactly what the model says, ignoring the server clock', async () => {
    const model = build();
    const table = [
      { ...order('ALG00000001', { status: 'FILLED' }), lastUpdateTime: 5 },
      { ...order('ALG00000002', { filledQty: 10, numFills: 1 }), lastUpdateTime: 99 },
      order('ALG00000003'),
    ] as unknown as Row[];
    const check = await checkModelVsServer({ driver: driverOf(model, 'ALG00000002'), reader: fakeReader(table), baselineRowCount: 2 });
    expect(check.failures).toEqual([]);
    expect(check.ok).toBe(true);
    expect(check.stats['created']).toBe(1);
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
