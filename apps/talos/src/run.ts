import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { CodecName, LoadPreset } from '@apeiron/logos';
import type { Options } from './args.js';
import { TalosClient } from './client.js';
import { runNormalClient } from './normal-client.js';
import { RunRecorder } from './recorder.js';
import { buildReport, type LagCumulative, type Phases, type Report } from './report.js';
import { clientRng, planClients, type ClientPlan } from './scenario.js';
import { MetricsScraper, fetchText, type Fetcher } from './scraper.js';
import { realClock, type Clock } from './schedule.js';
import { runCodecSwitcher, runSlowConsumer, runStressWindow } from './special.js';
import type { Connector } from './socket.js';

export type RunDeps = {
  connect: Connector;
  clock?: Clock;
  fetcher?: Fetcher;
  /** Called when the run is over, before the report is built, for tests. */
  onFinish?: () => void;
  /** Becomes true to end the run early (Ctrl-C). */
  stopped?: () => boolean;
  log?: (line: string) => void;
};

/** Where the stress window sits, or null when the run is too short for it or it is switched off. */
export function stressPhases(options: Pick<Options, 'duration' | 'stressAt' | 'stressFor' | 'noSpecial'>): Phases | null {
  if (options.noSpecial || options.stressFor <= 0 || options.duration < options.stressFor + 10) return null;
  const from = options.stressAt ?? Math.floor((options.duration - options.stressFor) / 2);
  if (from + options.stressFor > options.duration) return null;
  return { stressFromS: from, stressToS: from + options.stressFor };
}

export async function fetchLag(base: string, fetcher: Fetcher, reset: boolean): Promise<LagCumulative | null> {
  try {
    const text = await fetcher(`${base}/debug/lag${reset ? '?reset=1' : ''}`);
    const body = JSON.parse(text) as { lag?: { p50: number; p99: number; max: number; samples: number } };
    return body.lag ?? null;
  } catch {
    return null;
  }
}

/** Runs one load test against the server and returns the report. */
export async function runLoadTest(options: Options, deps: RunDeps): Promise<Report> {
  const clock = deps.clock ?? realClock;
  const fetcher = deps.fetcher ?? fetchText;
  const log = deps.log ?? ((): void => undefined);
  const nowMs = clock.now();
  const startMs = nowMs;
  const endMs = startMs + options.duration * 1000;
  const recorder = new RunRecorder(startMs);
  let halt = false;
  const stopped = (): boolean => halt || deps.stopped?.() === true;
  const metricsOn = options.metrics !== 'off';
  const metricsBase = metricsOn ? new URL(options.metrics).origin : null;
  const scraper = metricsOn ? new MetricsScraper(options.metrics, clock, startMs, 2_000, fetcher) : null;
  if (metricsBase !== null) await fetchLag(metricsBase, fetcher, true);
  scraper?.start();
  const generatorLag = monitorEventLoopDelay({ resolution: 10 });
  generatorLag.enable();

  const phases = stressPhases(options);
  const plans = planClients({ clients: options.clients, codec: options.codec, seed: options.seed, special: !options.noSpecial, nowMs });
  const all: TalosClient[] = [];
  let seenPreset: LoadPreset | null = null;

  const open = async (plan: ClientPlan, excludeLatency: boolean): Promise<TalosClient | null> => {
    try {
      const socket = await deps.connect(options.url);
      const client = new TalosClient({
        clientId: plan.clientId,
        traderId: plan.traderId,
        codec: plan.codec,
        socket,
        clock,
        recorder,
        excludeLatency,
        onPreset: (preset, at) => {
          if (preset !== seenPreset) {
            seenPreset = preset;
            recorder.event('preset.seen', at, { preset });
          }
        },
      });
      all.push(client);
      return client;
    } catch {
      recorder.count('connectFailures');
      return null;
    }
  };

  const slowBase = (): number => scraper?.samples.at(-1)?.slowConsumers ?? 0;
  const tasks: Promise<void>[] = [];
  for (const plan of plans) {
    tasks.push(
      (async (): Promise<void> => {
        const client = await open(plan, plan.role === 'slow');
        if (client === null) return;
        if (plan.role === 'slow') {
          const base = slowBase();
          await runSlowConsumer({
            client,
            clock,
            recorder,
            connect: () => open({ ...plan, clientId: `${plan.clientId}-again` }, false),
            pauseAtMs: startMs + options.slowAt * 1000,
            endMs,
            serverClosedIt: () => (scraper?.samples.at(-1)?.slowConsumers ?? 0) > base,
            stopped,
          });
          return;
        }
        const rng = clientRng(options.seed, plan.index + 10_000);
        const jobs: Promise<void>[] = [
          runNormalClient({
            client,
            plan,
            clock,
            recorder,
            rng,
            nowMs,
            endMs,
            scrollPerSec: options.scrollRate,
            changeEverySec: options.changeEvery,
            commandPerSec: options.commandRate,
            stopped,
            extra:
              plan.role === 'switcher'
                ? (view): Promise<void> => runCodecSwitcher({ client, clock, recorder, view, startMs, endMs, everyMs: options.switchEvery * 1000, stopped })
                : undefined,
          }),
        ];
        if (plan.controller && phases !== null) {
          jobs.push(runStressWindow({ client, clock, recorder, startAtMs: startMs + phases.stressFromS * 1000, durationMs: options.stressFor * 1000, endMs, stopped }));
        }
        await Promise.all(jobs);
      })(),
    );
  }
  log(`running ${plans.length} clients for ${options.duration}s`);
  await Promise.all(tasks);
  halt = true;
  deps.onFinish?.();
  await clock.sleep(500);
  for (const c of all) if (!c.closed) c.close();
  await scraper?.stop();
  generatorLag.disable();
  const lag = metricsBase === null ? null : await fetchLag(metricsBase, fetcher, false);

  const pausedAt = recorder.events.find((e) => e.name === 'slow.paused')?.t;
  if (scraper !== null && pausedAt !== undefined) {
    const soft = scraper.firstGrowth('softConflates', pausedAt);
    const slow = scraper.firstGrowth('slowConsumers', pausedAt);
    if (soft !== null) recorder.events.push({ t: soft, name: 'server.soft_conflate_first_seen', detail: { note: 'first /metrics scrape after the pause that shows deltas being held back' } });
    if (slow !== null) recorder.events.push({ t: slow, name: 'server.slow_consumer_first_seen', detail: { note: 'first /metrics scrape that shows the client closed with SLOW_CONSUMER' } });
    recorder.events.sort((a, b) => a.t - b.t);
  }

  const clientsByCodec: Partial<Record<CodecName, number>> = {};
  for (const p of plans) clientsByCodec[p.codec] = (clientsByCodec[p.codec] ?? 0) + 1;
  return buildReport({
    meta: {
      startedAt: new Date(startMs).toISOString(),
      durationS: options.duration,
      clients: options.clients,
      codec: options.codec,
      url: options.url,
      metricsUrl: metricsOn ? options.metrics : null,
      seed: options.seed,
      options: { ...options },
    },
    recorder,
    clientsByCodec,
    phases,
    resources: scraper === null ? null : scraper.report(),
    first: scraper?.first ?? null,
    last: scraper?.last ?? null,
    lagCumulative: lag,
    generatorLag: { p99: Math.max(0, generatorLag.percentile(99) / 1e6 - 10), max: Math.max(0, generatorLag.max / 1e6 - 10) },
  });
}
