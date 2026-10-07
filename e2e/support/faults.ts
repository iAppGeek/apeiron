/** A typed client for the Toxiproxy HTTP API, scoped to the one proxy (`ws`) that carries the browser's WebSocket. */

export type Direction = 'upstream' | 'downstream' | 'both';
type Stream = 'upstream' | 'downstream';

export type FaultsOptions = {
  /** Toxiproxy's API (default http://127.0.0.1:8474). */
  api?: string;
  proxy?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export type Faults = {
  /** Resets every live connection (TCP RST) and lets new ones through again almost at once. */
  dropClean(): Promise<void>;
  /** Disables the proxy, which closes every connection and refuses new ones, for `ms`, then enables it. */
  down(ms: number): Promise<void>;
  /** Half-open stall: data stops flowing both ways and nothing is closed. Undo with {@link Faults.clear}. */
  stall(): Promise<void>;
  latency(ms: number, jitterMs: number): Promise<void>;
  /** Limits throughput to `kbps` kilobytes per second in the given direction. */
  bandwidth(kbps: number, direction: Direction): Promise<void>;
  /** Enables the proxy and removes every toxic. */
  clear(): Promise<void>;
  /** The toxics currently on the proxy. */
  toxics(): Promise<string[]>;
};

type ToxicBody = { name: string; type: string; stream: Stream; toxicity: number; attributes: Record<string, number> };

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** How long the reset toxic stays on: long enough for every live connection to be reset, short enough that the retry gets through. */
export const RESET_WINDOW_MS = 600;

export function createFaults(options: FaultsOptions = {}): Faults {
  const api = options.api ?? 'http://127.0.0.1:8474';
  const proxy = options.proxy ?? 'ws';
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;

  const call = async (method: string, path: string, body?: unknown, okStatuses: readonly number[] = []): Promise<unknown> => {
    const response = await doFetch(`${api}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (!response.ok && !okStatuses.includes(response.status)) {
      throw new Error(`Toxiproxy ${method} ${path} failed with ${response.status}: ${await response.text()}`);
    }
    const text = await response.text();
    return text === '' ? null : (JSON.parse(text) as unknown);
  };

  const removeToxic = async (name: string): Promise<void> => {
    await call('DELETE', `/proxies/${proxy}/toxics/${name}`, undefined, [404]);
  };

  const addToxic = async (toxic: ToxicBody): Promise<void> => {
    await removeToxic(toxic.name);
    await call('POST', `/proxies/${proxy}/toxics`, toxic);
  };

  const streamsOf = (direction: Direction): Stream[] => (direction === 'both' ? ['upstream', 'downstream'] : [direction]);

  const setEnabled = async (enabled: boolean): Promise<void> => {
    await call('POST', `/proxies/${proxy}`, { enabled });
  };

  return {
    async dropClean(): Promise<void> {
      await addToxic({ name: 'reset', type: 'reset_peer', stream: 'downstream', toxicity: 1, attributes: { timeout: 0 } });
      await sleep(RESET_WINDOW_MS);
      await removeToxic('reset');
    },

    async down(ms: number): Promise<void> {
      await setEnabled(false);
      try {
        await sleep(ms);
      } finally {
        await setEnabled(true);
      }
    },

    async stall(): Promise<void> {
      for (const stream of streamsOf('both')) {
        await addToxic({ name: `stall-${stream}`, type: 'timeout', stream, toxicity: 1, attributes: { timeout: 0 } });
      }
    },

    async latency(ms: number, jitterMs: number): Promise<void> {
      for (const stream of streamsOf('both')) {
        await addToxic({ name: `latency-${stream}`, type: 'latency', stream, toxicity: 1, attributes: { latency: ms, jitter: jitterMs } });
      }
    },

    async bandwidth(kbps: number, direction: Direction): Promise<void> {
      for (const stream of streamsOf(direction)) {
        await addToxic({ name: `bandwidth-${stream}`, type: 'bandwidth', stream, toxicity: 1, attributes: { rate: kbps } });
      }
    },

    async clear(): Promise<void> {
      const list = await this.toxics();
      for (const name of list) await removeToxic(name);
      await setEnabled(true);
    },

    async toxics(): Promise<string[]> {
      const body = (await call('GET', `/proxies/${proxy}/toxics`)) as { name: string }[] | null;
      return (body ?? []).map((t) => t.name);
    },
  };
}
