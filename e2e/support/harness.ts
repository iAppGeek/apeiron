import type { Browser } from '@playwright/test';
import { NatsBus } from '@apeiron/iris';
import { MongoOrderRepository } from '@apeiron/mnemosyne';
import { createDriver, startHermesContainer, stopHermesContainer, type Driver, type DriverRate } from './driver';
import { createFaults, type Faults } from './faults';
import {
  checkInvariants,
  checkMinimums,
  checkModelVsServer,
  checkServerVsScreen,
  type Check,
  type Minimums,
} from './oracle';
import { openView, readSnapshot, readStats, type PageStats, type ViewId, type ViewPage } from './pages';
import { failuresOf, summariseLatency, writeReport, type ScenarioReport, type ViewReport } from './report';
import { installSamplerInPage, readSamplerInPage } from './sampler';
import { createServerProbe, type ServerProbe } from './server-probe';
import { openReader } from './ws-client';

const MONGO_URL = process.env['RESILIENCE_MONGO_URL'] ?? 'mongodb://127.0.0.1:27017';
const MONGO_DB = process.env['RESILIENCE_MONGO_DB'] ?? 'blotter';
const NATS_URL = process.env['RESILIENCE_NATS_URL'] ?? 'nats://127.0.0.1:4222';
/** Quiet for this long (no delta applied on a page) before the checks run. */
export const QUIET_MS = 2000;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Polls `condition` until it holds or `timeoutMs` passes; returns whether it held. */
export async function until(condition: () => Promise<boolean>, timeoutMs: number, intervalMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition().catch(() => false)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

export type HarnessOptions = {
  browser: Browser;
  scenario: string;
  title: string;
  views: readonly ViewId[];
  rate: DriverRate;
  seed: number;
};

export type Harness = {
  pages: readonly ViewPage[];
  faults: Faults;
  driver: Driver;
  /** Starts the sampler on every page and the update stream. Call once the faults are ready. */
  begin(): Promise<void>;
  /** Milliseconds since `begin`. */
  elapsed(): number;
  /** Records a fault in the report. */
  note(kind: string, detail?: string): void;
  measure(key: string, value: number | string | number[]): void;
  /** Per-page counters now. */
  stats(): Promise<PageStats[]>;
  /** Per-page counters since `begin`. */
  since(): Promise<{ reconnects: number; deltasApplied: number }[]>;
  /** Waits until every page shows Connected and is not busy. */
  allConnected(timeoutMs: number): Promise<boolean>;
  /** Runs check 2 on every page right now, without stopping anything. The canary uses it to prove the check can fail. */
  screens(): Promise<Check[]>;
  /** Stops the stream, waits for everything to go quiet, runs the three checks and writes the report. */
  end(minimums: Minimums): Promise<ScenarioReport>;
  /** Puts the stack back: no toxics, hermes running, pages closed. Safe to call twice, and must run after a failure. */
  teardown(): Promise<void>;
};

export async function createHarness(options: HarnessOptions): Promise<Harness> {
  const faults = createFaults();
  const probe: ServerProbe = createServerProbe();
  let bus: NatsBus | null = null;
  let repo: MongoOrderRepository | null = null;
  let driver: Driver | null = null;
  let pages: ViewPage[] = [];
  let tornDown = false;
  let beganAt = 0;
  let baseline: PageStats[] = [];
  const faultLog: ScenarioReport['faults'] = [];
  const measurements: ScenarioReport['measurements'] = {};
  const latencySamples = new Map<ViewId, { p50: number | null; p95: number | null }[]>();
  let latencyTimer: ReturnType<typeof setInterval> | null = null;
  let baselineRows = 0;
  let began = false;

  const teardown = async (): Promise<void> => {
    if (tornDown) return;
    tornDown = true;
    if (latencyTimer !== null) clearInterval(latencyTimer);
    const errors: unknown[] = [];
    const attempt = async (step: () => Promise<unknown>): Promise<void> => {
      try {
        await step();
      } catch (error) {
        errors.push(error);
      }
    };
    await attempt(() => driver?.stop() ?? Promise.resolve());
    await attempt(() => faults.clear());
    await attempt(() => Promise.all(pages.map((p) => p.page.context().close())));
    await attempt(() => bus?.close() ?? Promise.resolve());
    await attempt(() => repo?.close() ?? Promise.resolve());
    await attempt(() => startHermesContainer());
    if (errors.length > 0) throw new AggregateError(errors, 'teardown had errors');
  };

  try {
    await faults.clear();
    await stopHermesContainer();
    const quiet = await until(() => probe.isIdle(), 90_000);
    if (!quiet) throw new Error('the server did not go idle after hermes stopped');
    bus = await NatsBus.connect({ url: NATS_URL, name: `e2e-${options.scenario}` });
    repo = await MongoOrderRepository.connect({ url: MONGO_URL, db: MONGO_DB });
    const reader = await openReader();
    const serverOffsetMs = reader.serverOffsetMs;
    baselineRows = (
      await reader.getRows({ startRow: 0, endRow: 1, rowGroupCols: [], valueCols: [], groupKeys: [], sortModel: [{ colId: 'orderId', sort: 'desc' }] })
    ).rowCount;
    reader.close();
    driver = createDriver({ bus, repo, seed: options.seed, rate: options.rate, clockOffsetMs: serverOffsetMs });
    pages = await Promise.all(options.views.map((id) => openView(options.browser, id)));
  } catch (error) {
    await teardown().catch(() => undefined);
    throw error;
  }

  const runningDriver = driver;

  const harness: Harness = {
    pages,
    faults,
    driver: runningDriver,

    async begin(): Promise<void> {
      baseline = await Promise.all(pages.map((p) => readStats(p.page)));
      await Promise.all(pages.map((p) => p.page.evaluate(installSamplerInPage, 500)));
      latencyTimer = setInterval(() => {
        for (const p of pages) {
          void readStats(p.page)
            .then((s) => {
              latencySamples.set(p.id, [...(latencySamples.get(p.id) ?? []), s.latency]);
            })
            .catch(() => undefined);
        }
      }, 1000);
      beganAt = Date.now();
      began = true;
      await runningDriver.start();
    },

    elapsed: () => Date.now() - beganAt,

    note(kind: string, detail?: string): void {
      faultLog.push({ kind, atMs: Date.now() - beganAt, ...(detail === undefined ? {} : { detail }) });
    },

    measure(key: string, value: number | string | number[]): void {
      measurements[key] = value;
    },

    stats: () => Promise.all(pages.map((p) => readStats(p.page))),

    async since(): Promise<{ reconnects: number; deltasApplied: number }[]> {
      const now = await Promise.all(pages.map((p) => readStats(p.page)));
      return now.map((s, i) => ({
        reconnects: s.reconnects - (baseline[i]?.reconnects ?? 0),
        deltasApplied: s.deltasApplied - (baseline[i]?.deltasApplied ?? 0),
      }));
    },

    allConnected: (timeoutMs) =>
      until(async () => (await Promise.all(pages.map((p) => readStats(p.page)))).every((s) => s.state === 'connected' && !s.busy), timeoutMs, 250),

    async screens(): Promise<Check[]> {
      const out: Check[] = [];
      for (const p of pages) {
        const snapshot = await readSnapshot(p.page);
        const reader = await openReader({ traderId: snapshot.view.trader });
        out.push(await checkServerVsScreen(`server-vs-screen ${p.id}`, snapshot, reader));
        reader.close();
      }
      return out;
    },

    async end(minimums: Minimums): Promise<ScenarioReport> {
      if (!began) throw new Error('end() before begin()');
      const startedAt = new Date(beganAt);
      const runMs = Date.now() - beganAt;
      await runningDriver.stop();
      if (latencyTimer !== null) clearInterval(latencyTimer);
      latencyTimer = null;

      // Quiesce: the stream is stopped, so wait for the server to drain and every page to be connected and quiet.
      const settleStart = Date.now();
      const settled = await until(async () => {
        if (!(await probe.isIdle())) return false;
        const all = await Promise.all(pages.map((p) => readStats(p.page)));
        return all.every((s) => s.state === 'connected' && !s.busy && (s.sinceLastDeltaMs === null || s.sinceLastDeltaMs > QUIET_MS));
      }, 180_000);
      const settleMs = Date.now() - settleStart;

      const verifyStart = Date.now();
      const checks: Check[] = [];
      if (!settled) {
        checks.push({ name: 'quiesce', ok: false, failures: [`the server and pages did not go quiet within ${settleMs}ms`], stats: {} });
      }
      const driverStats = runningDriver.stats();
      if (driverStats.publishErrors > 0) {
        checks.push({ name: 'driver', ok: false, failures: [`${driverStats.publishErrors} publishes failed, so the model cannot be trusted`], stats: {} });
      }

      const stats = await Promise.all(pages.map((p) => readStats(p.page)));
      const reader = await openReader();
      checks.push(await checkModelVsServer({ driver: runningDriver, reader, baselineRowCount: baselineRows }));
      reader.close();

      const views: ViewReport[] = [];
      for (const [i, p] of pages.entries()) {
        const s = stats[i] as PageStats;
        const before = baseline[i] as PageStats;
        const snapshot = await readSnapshot(p.page);
        const pageReader = await openReader({ traderId: snapshot.view.trader });
        const screen = await checkServerVsScreen('server-vs-screen', snapshot, pageReader);
        if (!screen.ok) {
          // Tell a permanent difference from a late one: look again after a few seconds. The check still fails either way.
          await sleep(4000);
          const again = await checkServerVsScreen('server-vs-screen', await readSnapshot(p.page), pageReader);
          screen.stats['stillWrongAfter4s'] = again.ok ? 'no' : 'yes';
          if (!again.ok) screen.stats['failuresAfter4s'] = again.stats['failures'] ?? 0;
        }
        pageReader.close();
        const sampler = await p.page.evaluate(readSamplerInPage);
        const reconnects = s.reconnects - before.reconnects;
        const deltas = s.deltasApplied - before.deltasApplied;
        views.push({
          view: p.id,
          reconnects,
          deltasApplied: deltas,
          rowsUpdated: s.rowsUpdated - before.rowsUpdated,
          purges: s.purges - before.purges,
          lastCloseReason: s.lastCloseReason,
          closeHistory: s.closeHistory,
          toasts: s.toastHistory,
          latency: summariseLatency(latencySamples.get(p.id) ?? []),
          checks: [screen, checkInvariants('invariants', sampler), checkMinimums('minimums', { reconnects, deltas }, minimums)],
        });
      }
      const finishedAt = new Date();
      const failures = failuresOf(views, checks);
      const report: ScenarioReport = {
        scenario: options.scenario,
        title: options.title,
        ok: failures.length === 0,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        timings: { runMs, settleMs, verifyMs: finishedAt.getTime() - verifyStart, totalMs: finishedAt.getTime() - beganAt },
        rate: options.rate,
        seed: options.seed,
        driver: driverStats,
        faults: faultLog,
        measurements,
        views,
        checks,
        failures,
      };
      writeReport(report);
      return report;
    },

    teardown,
  };
  return harness;
}
