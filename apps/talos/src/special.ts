import type { CodecName, LoadPreset } from '@apeiron/logos';
import type { TalosClient } from './client.js';
import type { Recorder } from './recorder.js';
import type { Clock } from './schedule.js';
import { requestFor, type ViewSpec } from './scenario.js';

const FILL_ROWS = 2_000;

export type SlowConsumerDeps = {
  /** Opens a fresh connection (used to reconnect after the server closes this one). */
  connect: () => Promise<TalosClient | null>;
  client: TalosClient;
  clock: Clock;
  recorder: Recorder;
  /** Run-clock ms when the client stops reading. */
  pauseAtMs: number;
  endMs: number;
  /** Longest it stays paused if the server does not close it. */
  maxPauseMs?: number;
  /** True once the server reports a slow-consumer close (read from the scraped metrics). */
  serverClosedIt: () => boolean;
  stopped: () => boolean;
};

const HEAVY_VIEW: ViewSpec = {
  rowGroupCols: [],
  valueCols: [],
  sortModel: [{ colId: 'createdAt', sort: 'desc' }],
  filterModel: { status: { filterType: 'set', values: ['LIVE', 'PAUSED'] } },
};
const FILL_VIEW: ViewSpec = { rowGroupCols: [], valueCols: [], sortModel: [{ colId: 'notionalUsd', sort: 'desc' }], filterModel: null };

/**
 * A client that stops reading its socket. It tracks the LIVE and PAUSED orders (so the server keeps sending it deltas),
 * then pauses reads and keeps asking for 2,000-row blocks, so the server's send buffer for it grows past the soft cap
 * (deltas are conflated) and then stays there until the server closes it with SLOW_CONSUMER. It then resumes reading,
 * records what it received and reconnects to check the server still serves it.
 */
export async function runSlowConsumer(d: SlowConsumerDeps): Promise<void> {
  const { client, clock, recorder } = d;
  if (!(await client.hello())) {
    recorder.count('connectFailures');
    return;
  }
  await client.getRows(requestFor(HEAVY_VIEW, 0), clock.now(), true);
  while (clock.now() < d.pauseAtMs && !d.stopped()) await clock.sleep(Math.min(500, d.pauseAtMs - clock.now()));
  if (d.stopped() || client.closed) return;

  const pausedAt = clock.now();
  client.pauseReading();
  recorder.event('slow.paused', pausedAt);
  const maxPause = d.maxPauseMs ?? 60_000;
  let fills = 0;
  while (!d.stopped() && !client.closed && clock.now() - pausedAt < maxPause && clock.now() < d.endMs && !d.serverClosedIt()) {
    void client.getRows(requestFor(FILL_VIEW, 0, [], FILL_ROWS), clock.now(), false);
    fills++;
    await clock.sleep(1_000);
  }
  recorder.event('slow.server_closed_seen', clock.now(), { serverClosedIt: d.serverClosedIt(), fills });
  client.resumeReading();
  recorder.event('slow.resumed', clock.now(), { pausedMs: clock.now() - pausedAt });
  for (let i = 0; i < 30 && !client.closed && client.slowConsumerAt === null; i++) await clock.sleep(500);
  recorder.event('slow.after_resume', clock.now(), { slowConsumerError: client.slowConsumerAt !== null, closed: client.closed, closeCode: client.closeCode });
  if (client.slowConsumerAt !== null) recorder.event('slow.error_received', client.slowConsumerAt);
  if (!client.closed) {
    client.close();
    return;
  }
  const again = await d.connect();
  if (again === null || !(await again.hello())) {
    recorder.event('slow.reconnect', clock.now(), { ok: false });
    return;
  }
  const outcome = await again.getRows(requestFor(HEAVY_VIEW, 0), clock.now(), true);
  recorder.event('slow.reconnect', clock.now(), { ok: outcome.ok, ms: outcome.ms });
  again.close();
}

export type SwitcherDeps = {
  client: TalosClient;
  clock: Clock;
  recorder: Recorder;
  view: () => ViewSpec;
  startMs: number;
  endMs: number;
  everyMs: number;
  stopped: () => boolean;
};

/** Re-sends `hello` with the other codec every period and checks that `getRows` works, in the right frame type, after each switch. */
export async function runCodecSwitcher(d: SwitcherDeps): Promise<void> {
  const { client, clock, recorder } = d;
  for (let k = 1; ; k++) {
    const at = d.startMs + k * d.everyMs;
    if (at >= d.endMs || d.stopped()) return;
    if (at > clock.now()) await clock.sleep(at - clock.now());
    if (d.stopped() || client.closed) return;
    const to: CodecName = client.codec === 'json' ? 'msgpack' : 'json';
    const welcomed = await client.hello(to);
    const sent = clock.now();
    const outcome = await client.getRows(requestFor(d.view(), 0), sent, true);
    const frameTypeOk = outcome.ok && outcome.binary === (to === 'msgpack');
    recorder.event('codec.switch', clock.now(), { to, welcomed, getRowsOk: outcome.ok, frameTypeOk, ms: outcome.ms, code: outcome.ok ? null : outcome.code });
  }
}

export type StressDeps = {
  client: TalosClient;
  clock: Clock;
  recorder: Recorder;
  startAtMs: number;
  durationMs: number;
  endMs: number;
  stopped: () => boolean;
};

/** Switches hermes to the stress preset for a window in the middle of the run, then back to medium. */
export async function runStressWindow(d: StressDeps): Promise<void> {
  const { client, clock, recorder } = d;
  const set = async (preset: LoadPreset): Promise<void> => {
    const requested = clock.now();
    const ok = await client.control(preset);
    recorder.event(`stress.${preset}`, requested, { acked: ok, ackMs: clock.now() - requested });
  };
  while (clock.now() < d.startAtMs && !d.stopped()) await clock.sleep(Math.min(500, d.startAtMs - clock.now()));
  if (d.stopped()) return;
  try {
    await set('stress');
    const until = Math.min(d.startAtMs + d.durationMs, d.endMs);
    while (clock.now() < until && !d.stopped()) await clock.sleep(Math.min(500, until - clock.now()));
  } finally {
    if (!client.closed) await set('medium');
  }
}
