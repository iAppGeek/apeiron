import type { Rng } from '@apeiron/logos';
import type { TalosClient } from './client.js';
import type { Recorder } from './recorder.js';
import { Timeline, runTimeline, type Clock } from './schedule.js';
import { ViewKnowledge, changeView, pickScrollTarget, requestFor, type ClientPlan, type ViewSpec } from './scenario.js';

export type NormalDeps = {
  client: TalosClient;
  plan: ClientPlan;
  clock: Clock;
  recorder: Recorder;
  rng: Rng;
  /** Wall-clock anchors for dates in generated filters. */
  nowMs: number;
  endMs: number;
  scrollPerSec: number;
  changeEverySec: number;
  commandPerSec: number;
  pingEveryMs?: number;
  stopped: () => boolean;
  /** Runs alongside the normal behaviour once connected (the codec switcher uses it). */
  extra?: (view: () => ViewSpec) => Promise<void>;
};

/** Sends a stream on a fixed timeline; each send is recorded with how late it went out. */
function stream(d: NormalDeps, intervalMs: number, jitter: number, fire: (intendedAt: number) => void): Promise<number> {
  const timeline = new Timeline({ startMs: d.clock.now() + d.rng() * intervalMs, intervalMs, jitter, rng: d.rng });
  return runTimeline({
    clock: d.clock,
    timeline,
    endMs: d.endMs,
    stopped: d.stopped,
    fire: (intendedAt, actualAt) => {
      d.recorder.sendLag(actualAt, actualAt - intendedAt);
      fire(intendedAt);
    },
  });
}

/**
 * A trader at a blotter: connects, opens its view, then scrolls at a fixed rate (with group drill-downs), now and
 * then changes the sort, filter or grouping (a cold view), and now and then pauses and resumes a LIVE order.
 * Latency of every request is measured from its intended send time.
 */
export async function runNormalClient(d: NormalDeps): Promise<void> {
  const { client, recorder } = d;
  if (!(await client.hello())) {
    recorder.count('connectFailures');
    return;
  }
  let view = d.plan.view;
  let knowledge = new ViewKnowledge(view);

  const open = async (intendedAt: number, cold: boolean): Promise<void> => {
    const forView = view;
    const forKnowledge = knowledge;
    const outcome = await client.getRows(requestFor(forView, 0), intendedAt, cold);
    if (outcome.ok && forView === view) forKnowledge.learn([], outcome.rows, outcome.rowCount);
  };
  await open(d.clock.now(), true);

  const scroll = stream(d, 1000 / d.scrollPerSec, 0.3, (intendedAt) => {
    const forView = view;
    const forKnowledge = knowledge;
    const target = pickScrollTarget(d.rng, forView, forKnowledge);
    recorder.count('scrolls');
    void client.getRows(requestFor(forView, target.startRow, target.groupKeys), intendedAt, false).then((outcome) => {
      if (outcome.ok && forView === view) forKnowledge.learn(target.groupKeys, outcome.rows, outcome.rowCount);
    });
  });

  const change = stream(d, d.changeEverySec * 1000, 0.4, (intendedAt) => {
    view = changeView(d.rng, view, d.nowMs);
    knowledge = new ViewKnowledge(view);
    recorder.count('viewChanges');
    void open(intendedAt, true);
  });

  let paused: string | null = null;
  const commands = stream(d, 1000 / d.commandPerSec, 0.4, (intendedAt) => {
    let orderId: string | undefined;
    let action: 'PAUSE' | 'RESUME' = 'PAUSE';
    if (paused !== null && client.liveOrders.get(paused) === 'PAUSED') {
      orderId = paused;
      action = 'RESUME';
    } else {
      paused = null;
      const live = [...client.liveOrders].filter(([, status]) => status === 'LIVE').map(([id]) => id);
      orderId = live[Math.floor(d.rng() * live.length)];
    }
    if (orderId === undefined) {
      recorder.count('commandsSkipped');
      return;
    }
    const target = orderId;
    recorder.count('commandsSent');
    void client.command(target, action, intendedAt).then((result) => {
      if (result === 'ack') paused = action === 'PAUSE' ? target : null;
      else if (action === 'RESUME') paused = null;
    });
  });

  const ping = stream(d, d.pingEveryMs ?? 5_000, 0, () => client.ping());

  await Promise.all([scroll, change, commands, ping, d.extra?.(() => view) ?? Promise.resolve()]);
  if (client.closed && !d.stopped()) recorder.count('unexpectedCloses');
}
