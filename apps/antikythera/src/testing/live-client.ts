import {
  getCodec,
  jsonCodec,
  type ClientMsg,
  type CodecName,
  type Row,
  type ServerMsg,
  type SsrmRequest,
} from '@apeiron/logos';
import WebSocket, { type RawData } from 'ws';

export type Received = { at: number; bytes: number; msg: ServerMsg };

/** A minimal protocol client for measuring a live server: records every message with its arrival time and size. */
export class LiveClient {
  readonly received: Received[] = [];
  private readonly waiters: { pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
  private codec: CodecName = 'json';
  private reqId = 0;

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (raw: RawData, isBinary: boolean) => {
      const frame = isBinary ? (raw as Buffer) : raw.toString();
      const bytes = typeof frame === 'string' ? Buffer.byteLength(frame) : frame.length;
      const msg = (isBinary ? getCodec('msgpack') : jsonCodec).decode(frame) as ServerMsg;
      this.received.push({ at: Date.now(), bytes, msg });
      for (const w of [...this.waiters]) {
        if (w.pred(msg)) {
          clearTimeout(w.timer);
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    });
  }

  static async connect(url: string, traderId = 'ALL', codec: CodecName = 'json', clientId = `probe-${process.pid}`): Promise<LiveClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    const client = new LiveClient(socket);
    client.send({ t: 'hello', traderId, codec, clientId });
    await client.until((m) => m.t === 'welcome');
    return client;
  }

  send(msg: ClientMsg): void {
    const encoded = getCodec(this.codec).encode(msg);
    this.socket.send(encoded, { binary: typeof encoded !== 'string' });
    if (msg.t === 'hello') this.codec = msg.codec;
  }

  until(pred: (m: ServerMsg) => boolean, timeoutMs = 10_000): Promise<ServerMsg> {
    const seen = this.received.find((r) => pred(r.msg));
    if (seen !== undefined) return Promise.resolve(seen.msg);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a message')), timeoutMs);
      this.waiters.push({ pred, resolve, reject, timer });
    });
  }

  /** Sends `getRows` and resolves with the matching `rows` message. */
  async getRows(req: SsrmRequest): Promise<{ rows: Row[]; rowCount: number }> {
    const reqId = ++this.reqId;
    this.send({ t: 'getRows', reqId, req });
    const msg = await this.until((m) => (m.t === 'rows' && m.reqId === reqId) || (m.t === 'error' && m.reqId === reqId));
    if (msg.t === 'error') throw new Error(`${msg.code}: ${msg.message}`);
    if (msg.t !== 'rows') throw new Error('unreachable');
    return { rows: msg.rows, rowCount: msg.rowCount };
  }

  /** Sends `control` and resolves when it is acknowledged. */
  async control(preset: 'medium' | 'stress'): Promise<void> {
    const reqId = ++this.reqId;
    this.send({ t: 'control', reqId, preset });
    const msg = await this.until((m) => (m.t === 'ack' && m.reqId === reqId) || (m.t === 'error' && m.reqId === reqId));
    if (msg.t === 'error') throw new Error(`${msg.code}: ${msg.message}`);
  }

  /** Messages received at or after `since` (epoch ms). */
  since(since: number): Received[] {
    return this.received.filter((r) => r.at >= since);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.socket.once('close', () => resolve());
      this.socket.close();
    });
  }
}

export const percentile = (values: readonly number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number;
};

export const median = (values: readonly number[]): number => percentile(values, 50);

const round = (n: number, d = 2): number => Math.round(n * 10 ** d) / 10 ** d;

export const flatRequest = (start = 0, end = 100): SsrmRequest => ({
  startRow: start,
  endRow: end,
  rowGroupCols: [],
  valueCols: [],
  groupKeys: [],
  sortModel: [],
  filterModel: null,
});

export const groupedRequest = (keys: string[] = []): SsrmRequest => ({
  startRow: 0,
  endRow: 100,
  rowGroupCols: [{ id: 'status', field: 'status' }],
  valueCols: [
    { id: 'notionalUsd', field: 'notionalUsd', aggFunc: 'sum' },
    { id: 'slippageBps', field: 'slippageBps', aggFunc: 'wavg' },
    { id: 'unrealisedPnlUsd', field: 'unrealisedPnlUsd', aggFunc: 'sum' },
  ],
  groupKeys: keys,
  sortModel: [],
  filterModel: null,
});

export type DefaultViewReport = {
  seconds: number;
  trackedLiveRows: number;
  deltas: number;
  deltasPerSec: number;
  avgDeltaBytes: number;
  rowUpdatesPerSec: number;
  /** Median over the tracked LIVE rows of price updates per second. */
  liveRowTicksPerSecMedian: number;
  liveRowTicksPerSecP10: number;
  adds: number;
  addsPerSec: number;
  allAddsAtIndexZero: boolean;
  newAboveTotal: number;
  dirtyRoutes: number;
  deltaLatencyMs: { p50: number; p99: number };
  summary: Extract<ServerMsg, { t: 'summary' }> | null;
};

/** Subscribes to the default view's top block for `seconds` and reports update rates, adds and the summary. */
export async function measureDefaultView(client: LiveClient, seconds: number): Promise<DefaultViewReport> {
  const first = await client.getRows(flatRequest());
  const liveIds = new Set(first.rows.filter((r) => r.status === 'LIVE').map((r) => String(r.orderId)));
  const start = Date.now();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const end = Date.now();
  const window = client.since(start).filter((r) => r.at <= end);
  const deltas = window.filter((r) => r.msg.t === 'delta');
  const ticks = new Map<string, number>();
  let rowUpdates = 0;
  let adds = 0;
  let addsAtZero = true;
  let newAbove = 0;
  let dirty = 0;
  const latencies: number[] = [];
  let bytes = 0;
  for (const d of deltas) {
    if (d.msg.t !== 'delta') continue;
    bytes += d.bytes;
    latencies.push(d.at - d.msg.serverTs);
    newAbove += d.msg.newAbove;
    dirty += d.msg.dirtyRoutes.length;
    for (const u of d.msg.updates) {
      for (const row of u.rows) {
        rowUpdates++;
        if ('marketMid' in row && liveIds.has(row.orderId)) ticks.set(row.orderId, (ticks.get(row.orderId) ?? 0) + 1);
      }
    }
    for (const a of d.msg.adds) {
      adds += a.rows.length;
      if (a.addIndex !== 0) addsAtZero = false;
    }
  }
  const secs = (end - start) / 1000;
  const perRow = [...liveIds].map((id) => (ticks.get(id) ?? 0) / secs);
  const summaries = window.filter((r) => r.msg.t === 'summary');
  const last = summaries[summaries.length - 1]?.msg;
  return {
    seconds: round(secs, 1),
    trackedLiveRows: liveIds.size,
    deltas: deltas.length,
    deltasPerSec: round(deltas.length / secs),
    avgDeltaBytes: deltas.length === 0 ? 0 : Math.round(bytes / deltas.length),
    rowUpdatesPerSec: round(rowUpdates / secs),
    liveRowTicksPerSecMedian: round(median(perRow)),
    liveRowTicksPerSecP10: round(percentile(perRow, 10)),
    adds,
    addsPerSec: round(adds / secs),
    allAddsAtIndexZero: addsAtZero,
    newAboveTotal: newAbove,
    dirtyRoutes: dirty,
    deltaLatencyMs: { p50: percentile(latencies, 50), p99: percentile(latencies, 99) },
    summary: last?.t === 'summary' ? last : null,
  };
}

export type GroupedReport = {
  seconds: number;
  rootGroups: number;
  groupUpdateMessages: number;
  groupUpdatesPerSec: number;
  groupUpdateRowsPerSec: number;
  sampleGroupUpdate: Row | null;
  rowCountMessages: number;
  rowCountRoutes: string[];
  dirtyRoutes: number;
  childRowUpdatesPerSec: number;
  childAdds: number;
};

/**
 * Subscribes to a view grouped by status (the group rows plus the leaf rows of the LIVE group, where orders
 * come and go constantly) and reports what arrives.
 */
export async function measureGroupedView(client: LiveClient, seconds: number): Promise<GroupedReport> {
  const root = await client.getRows(groupedRequest());
  await client.getRows(groupedRequest(['LIVE']));
  const start = Date.now();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const end = Date.now();
  const deltas = client.since(start).filter((r) => r.at <= end && r.msg.t === 'delta');
  let gu = 0;
  let guRows = 0;
  let sample: Row | null = null;
  let rc = 0;
  const routes = new Set<string>();
  let dirty = 0;
  let child = 0;
  let childAdds = 0;
  for (const d of deltas) {
    if (d.msg.t !== 'delta') continue;
    if (d.msg.groupUpdates.length > 0) gu++;
    for (const g of d.msg.groupUpdates) {
      guRows += g.rows.length;
      sample ??= g.rows[0] ?? null;
    }
    if (d.msg.rowCounts.length > 0) rc++;
    for (const r of d.msg.rowCounts) routes.add(JSON.stringify(r.route));
    dirty += d.msg.dirtyRoutes.length;
    for (const u of d.msg.updates) child += u.rows.length;
    for (const a of d.msg.adds) childAdds += a.rows.length;
  }
  const secs = (end - start) / 1000;
  return {
    seconds: round(secs, 1),
    rootGroups: root.rowCount,
    groupUpdateMessages: gu,
    groupUpdatesPerSec: round(gu / secs),
    groupUpdateRowsPerSec: round(guRows / secs),
    sampleGroupUpdate: sample,
    rowCountMessages: rc,
    rowCountRoutes: [...routes],
    dirtyRoutes: dirty,
    childRowUpdatesPerSec: round(child / secs),
    childAdds,
  };
}
