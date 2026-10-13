/**
 * Reads antikythera's `/health` and `/debug/lag` and NATS's `/jsz` to say whether the system has finished with everything
 * published: the order service has drained its input, and the blotter has applied every change to the order-state bucket.
 */

export type ServerProbeOptions = {
  api?: string;
  natsMonitor?: string;
  fetch?: typeof fetch;
};

export type ServerSnapshot = {
  status: string;
  /** The blotter's startup stage; `ready` once it serves clients. */
  stage: string;
  rows: number;
  clients: number;
  pendingEvents: number;
  /** The highest `ORDER_STATE` revision the blotter has applied. */
  appliedRev: number;
  /** The last sequence in the `KV_ORDER_STATE` stream: the newest change the order service has published. */
  kvLastSeq: number;
  /** Messages in the order service's `themis-exec` consumer not yet delivered, and delivered but not acknowledged (it acks after it has stored and published them). */
  consumerPending: number;
  consumerAckPending: number;
  flushLagMs: number;
};

type Json = Record<string, unknown>;
const num = (value: unknown): number => (typeof value === 'number' ? value : 0);
const obj = (value: unknown): Json => (typeof value === 'object' && value !== null ? (value as Json) : {});

/** Pulls the fields we use out of the three responses; tolerant of missing sections. */
export function parseSnapshot(health: unknown, lag: unknown, jsz: unknown): ServerSnapshot {
  const h = obj(health);
  const live = obj(h['live']);
  let pending = 0;
  let ackPending = 0;
  let kvLastSeq = 0;
  for (const account of (obj(jsz)['account_details'] as unknown[] | undefined) ?? []) {
    for (const stream of (obj(account)['stream_detail'] as unknown[] | undefined) ?? []) {
      if (obj(stream)['name'] === 'KV_ORDER_STATE') kvLastSeq = num(obj(obj(stream)['state'])['last_seq']);
      for (const consumer of (obj(stream)['consumer_detail'] as unknown[] | undefined) ?? []) {
        const c = obj(consumer);
        if (c['name'] !== 'themis-exec') continue;
        pending += num(c['num_pending']);
        ackPending += num(c['num_ack_pending']);
      }
    }
  }
  return {
    status: typeof h['status'] === 'string' ? h['status'] : 'unknown',
    stage: typeof h['stage'] === 'string' ? h['stage'] : 'unknown',
    rows: num(h['rows']),
    clients: num(live['clients']),
    pendingEvents: num(live['pendingEvents']),
    appliedRev: num(obj(lag)['appliedRev']),
    kvLastSeq,
    consumerPending: pending,
    consumerAckPending: ackPending,
    flushLagMs: num(obj(obj(lag)['flush'])['lastMs']),
  };
}

export type ServerProbe = {
  snapshot(): Promise<ServerSnapshot>;
  /**
   * True once two consecutive snapshots both show the blotter ready with nothing queued, the order service's consumer
   * drained, and the blotter's applied revision equal to the newest published one and unchanged between them.
   */
  isIdle(): Promise<boolean>;
};

export function createServerProbe(options: ServerProbeOptions = {}): ServerProbe {
  const api = options.api ?? 'http://127.0.0.1:4000';
  const nats = options.natsMonitor ?? 'http://127.0.0.1:8222';
  const doFetch = options.fetch ?? fetch;
  let previous: ServerSnapshot | null = null;

  const get = async (url: string): Promise<unknown> => {
    const response = await doFetch(url);
    return (await response.json()) as unknown;
  };

  const snapshot = async (): Promise<ServerSnapshot> =>
    parseSnapshot(
      await get(`${api}/health`),
      await get(`${api}/debug/lag`),
      await get(`${nats}/jsz?streams=true&consumers=true`),
    );

  return {
    snapshot,
    async isIdle(): Promise<boolean> {
      const now = await snapshot();
      const before = previous;
      previous = now;
      return (
        before !== null &&
        now.status === 'ok' &&
        now.stage === 'ready' &&
        before.stage === 'ready' &&
        now.pendingEvents === 0 &&
        now.consumerPending === 0 &&
        now.consumerAckPending === 0 &&
        now.appliedRev === now.kvLastSeq &&
        now.appliedRev === before.appliedRev
      );
    },
  };
}

/** The value of one Prometheus counter line, for example `apeiron_backpressure_events_total{event="slow_consumer"}`; 0 if absent. */
export function readCounter(metricsText: string, name: string, labels: Record<string, string> = {}): number {
  let total = 0;
  for (const line of metricsText.split('\n')) {
    if (!line.startsWith(name) || line.startsWith('#')) continue;
    const rest = line.slice(name.length);
    if (rest[0] !== '{' && rest[0] !== ' ') continue;
    const matches = Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`));
    if (!matches) continue;
    total += Number(line.slice(line.lastIndexOf(' ') + 1));
  }
  return total;
}

/** Fetches antikythera's `/metrics` and reads one counter. */
export async function fetchCounter(name: string, labels: Record<string, string> = {}, api = 'http://127.0.0.1:4000'): Promise<number> {
  const response = await fetch(`${api}/metrics`);
  return readCounter(await response.text(), name, labels);
}
