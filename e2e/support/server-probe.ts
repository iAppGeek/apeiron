/** Reads antikythera's `/health` and `/debug/lag` and NATS's `/jsz` to say whether the server has finished with everything published. */

export type ServerProbeOptions = {
  api?: string;
  natsMonitor?: string;
  fetch?: typeof fetch;
};

export type ServerSnapshot = {
  status: string;
  rows: number;
  clients: number;
  pendingEvents: number;
  eventsApplied: number;
  ticksApplied: number;
  /** Messages in the blotter-server consumer not yet delivered, and delivered but not acknowledged (acked after persisting). */
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
  const l = obj(obj(lag)['live']);
  let pending = 0;
  let ackPending = 0;
  for (const account of (obj(jsz)['account_details'] as unknown[] | undefined) ?? []) {
    for (const stream of (obj(account)['stream_detail'] as unknown[] | undefined) ?? []) {
      for (const consumer of (obj(stream)['consumer_detail'] as unknown[] | undefined) ?? []) {
        const c = obj(consumer);
        if (c['name'] !== 'blotter-server') continue;
        pending += num(c['num_pending']);
        ackPending += num(c['num_ack_pending']);
      }
    }
  }
  return {
    status: typeof h['status'] === 'string' ? h['status'] : 'unknown',
    rows: num(h['rows']),
    clients: num(live['clients']),
    pendingEvents: num(live['pendingEvents']),
    eventsApplied: num(l['eventsApplied']),
    ticksApplied: num(l['ticksApplied']),
    consumerPending: pending,
    consumerAckPending: ackPending,
    flushLagMs: num(obj(obj(lag)['flush'])['lastMs']),
  };
}

export type ServerProbe = {
  snapshot(): Promise<ServerSnapshot>;
  /** True once two consecutive snapshots show nothing queued, nothing unacknowledged, and no event or tick applied between them. */
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
        now.pendingEvents === 0 &&
        now.consumerPending === 0 &&
        now.consumerAckPending === 0 &&
        now.eventsApplied === before.eventsApplied &&
        now.ticksApplied === before.ticksApplied
      );
    },
  };
}
