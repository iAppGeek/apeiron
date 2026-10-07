import { generateOrders } from './generator.js';
import type { Order } from './order.js';
import type { ClientMsg, Message, ServerMsg } from './protocol.js';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

/** Deterministic sample orders for tests. */
export function sampleOrders(count: number): Order[] {
  const out: Order[] = [];
  for (const o of generateOrders(42, 100_000, NOW)) {
    out.push(o);
    if (out.length >= count) break;
  }
  return out;
}

/** One example of every client message type. */
export function sampleClientMsgs(): ClientMsg[] {
  return [
    { t: 'hello', traderId: 'ALL', codec: 'msgpack', clientId: 'client-é-1' },
    {
      t: 'getRows',
      reqId: 7,
      req: {
        startRow: 0,
        endRow: 100,
        rowGroupCols: [{ id: 'currencyPair', field: 'currencyPair' }],
        valueCols: [{ id: 'notionalUsd', field: 'notionalUsd', aggFunc: 'sum' }],
        groupKeys: ['EURUSD'],
        sortModel: [{ colId: 'createdAt', sort: 'desc' }],
        filterModel: {
          status: { filterType: 'set', values: ['LIVE', 'PAUSED'] },
          orderQty: { filterType: 'number', operator: 'AND', conditions: [{ filterType: 'number', type: 'greaterThan', filter: 1e6 }] },
        },
      },
    },
    { t: 'setFilterValues', reqId: 8, colId: 'venue' },
    { t: 'command', reqId: 9, orderId: 'ALG00000001', action: 'CANCEL' },
    { t: 'control', reqId: 10, preset: 'stress' },
    { t: 'ping', ts: 1_700_000_000_123 },
  ];
}

/** One example of every server message type, with nulls, unicode and large numbers. */
export function sampleServerMsgs(): ServerMsg[] {
  const [a, b] = sampleOrders(2) as [Order, Order];
  return [
    {
      t: 'welcome',
      serverTime: NOW,
      traders: [{ traderId: 'T1', traderName: 'Alice Marlowe' }],
      columnsVersion: 'deadbeef',
      preset: 'medium',
    },
    { t: 'rows', reqId: 7, rows: [a, { currencyPair: 'EURUSD', childCount: 12, notionalUsd: 9.5e12, note: null }], rowCount: 1_000_000, ms: 3.25 },
    { t: 'filterValues', reqId: 8, values: ['EBS', 'LMAX', 'ünïcode'] },
    {
      t: 'delta',
      seq: 12,
      serverTs: NOW,
      updates: [{ route: [], rows: [{ orderId: a.orderId, marketMid: 1.08123, slippageBps: null }] }],
      groupUpdates: [{ route: ['EURUSD'], rows: [{ childCount: 3, notionalUsd: 123.45 }] }],
      adds: [{ route: [], addIndex: 0, rows: [b] }],
      dirtyRoutes: [[], ['EURUSD', 'BUY']],
      rowCounts: [
        { route: [], rowCount: 1_000_001 },
        { route: ['EURUSD'], rowCount: 251_000 },
      ],
      newAbove: 2,
    },
    {
      t: 'summary',
      byStatus: { PENDING_START: 200, LIVE: 400, PAUSED: 3, FILLED: 900_000, CANCELLED: 99_397 },
      liveNotionalUsd: 2.5e9,
      totalRows: 1_000_000,
      server: { cpu: 12.5, rssMb: 640, elLagMs: 1.5 },
      preset: null,
    },
    { t: 'ack', reqId: 9 },
    { t: 'error', reqId: 9, code: 'UNSUPPORTED_FILTER', message: 'bad filter' },
    { t: 'error', code: 'BAD_REQUEST', message: 'no req id' },
    { t: 'pong', ts: 1, serverTs: 2 },
  ];
}

export function sampleMessages(): Message[] {
  return [...sampleClientMsgs(), ...sampleServerMsgs()];
}
