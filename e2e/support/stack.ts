import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getCodec, jsonCodec, type ClientMsg, type ServerMsg } from '@apeiron/logos';
import { sleep, until } from './harness';

const run = promisify(execFile);
const root = new URL('../../', import.meta.url).pathname;

/** `docker compose restart <service>`: SIGTERM, the service's own shutdown, then start. Returns when compose has started it. */
export async function restartService(service: string): Promise<void> {
  await run('docker', ['compose', '--profile', 'core', 'restart', service], { cwd: root });
}

/** The compose health state of a service: `healthy`, `unhealthy`, `starting`, or `none`. */
export async function healthOf(service: string): Promise<string> {
  const { stdout } = await run('docker', ['compose', '--profile', 'core', 'ps', '--format', '{{.Health}}', service], { cwd: root });
  return stdout.trim() === '' ? 'none' : stdout.trim();
}

/** Waits until compose reports the service healthy. */
export async function waitHealthy(service: string, timeoutMs: number): Promise<boolean> {
  return until(async () => (await healthOf(service)) === 'healthy', timeoutMs, 1000);
}

const BLOTTER = process.env['BLOTTER_URL'] ?? 'http://127.0.0.1:4000';
const BLOTTER_WS = BLOTTER.replace(/^http/, 'ws');

export type Readiness = { live: number | null; ready: number | null };

/** `/health/live` and `/health/ready` status codes now, or null where the blotter does not answer. */
export async function readiness(): Promise<Readiness> {
  const status = async (path: string): Promise<number | null> => {
    const response = await fetch(`${BLOTTER}${path}`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
    return response === null ? null : response.status;
  };
  const [live, ready] = await Promise.all([status('/health/live'), status('/health/ready')]);
  return { live, ready };
}

export type ProbeResult = {
  /** Connections that got a welcome. */
  welcomed: number;
  /** getRows answered with `rows`. */
  served: number;
  /** getRows answered with `rows` while `/health/ready` did not say ready afterwards (a client served too early). */
  servedBeforeReady: number;
  /** Samples where the blotter was alive but not ready (loading, or draining). */
  liveNotReady: number;
  /** Samples where it answered ready. */
  ready: number;
  /** Samples where it did not answer at all. */
  down: number;
};

/** Asks the blotter, over a fresh socket each time, for the first rows, and records what answered and whether it was ready. */
async function askOnce(result: ProbeResult): Promise<void> {
  const state = await readiness();
  if (state.live === null) result.down += 1;
  else if (state.ready === 200) result.ready += 1;
  else result.liveNotReady += 1;
  await new Promise<void>((resolve) => {
    const socket = new WebSocket(`${BLOTTER_WS}/ws`);
    socket.binaryType = 'arraybuffer';
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve();
    };
    const timer = setTimeout(finish, 4000);
    socket.onerror = finish;
    socket.onclose = finish;
    socket.onopen = (): void => {
      const hello: ClientMsg = { t: 'hello', userId: 'SUPERVISOR', traderId: 'ALL', codec: 'json', clientId: `probe-${Math.random().toString(36).slice(2, 8)}` };
      socket.send(jsonCodec.encode(hello) as string);
    };
    socket.onmessage = (event): void => {
      const msg = (typeof event.data === 'string' ? jsonCodec.decode(event.data) : getCodec('msgpack').decode(new Uint8Array(event.data as ArrayBuffer))) as ServerMsg;
      if (msg.t === 'welcome') {
        result.welcomed += 1;
        const request: ClientMsg = { t: 'getRows', reqId: 1, req: { startRow: 0, endRow: 10, rowGroupCols: [], valueCols: [], groupKeys: [], sortModel: [] } };
        socket.send(jsonCodec.encode(request) as string);
      } else if (msg.t === 'rows') {
        result.served += 1;
        void readiness().then((after) => {
          // Ready only ever turns to draining, which is not ready: so a reply served by a blotter that never said ready is early.
          if (after.ready !== 200 && state.ready !== 200 && after.live !== null) result.servedBeforeReady += 1;
          finish();
        });
      }
    };
  });
}

/** Keeps asking until `stop` is called. Returns what it saw. */
export function startBlotterProbe(intervalMs = 150): { stop(): Promise<ProbeResult> } {
  const result: ProbeResult = { welcomed: 0, served: 0, servedBeforeReady: 0, liveNotReady: 0, ready: 0, down: 0 };
  let running = true;
  const loop = (async (): Promise<void> => {
    while (running) {
      await askOnce(result).catch(() => undefined);
      await sleep(intervalMs);
    }
  })();
  return {
    async stop(): Promise<ProbeResult> {
      running = false;
      await loop;
      return result;
    },
  };
}
