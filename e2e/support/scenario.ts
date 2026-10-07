import type { Browser } from '@playwright/test';
import { createHarness, sleep, type Harness } from './harness';
import type { Minimums } from './oracle';
import type { ViewId } from './pages';
import type { ScenarioReport } from './report';

/** `RESILIENCE_SMOKE=1` shortens the scenarios that have a smoke variant (CI runs those). */
export const SMOKE = process.env['RESILIENCE_SMOKE'] === '1';

export type ScenarioConfig = {
  id: string;
  title: string;
  views?: readonly ViewId[];
  rate: 'normal' | 'stress';
  seed: number;
  /** The faults and waiting. Returns when the run should stop publishing. */
  body: (harness: Harness) => Promise<void>;
  /** Minimums are computed after the body, so a scenario can base them on what it actually did. */
  minimums: (harness: Harness) => Minimums;
};

/** Runs one scenario end to end: set up, begin, run the body, quiesce, check, report, and always tear down. */
export async function runScenario(browser: Browser, config: ScenarioConfig): Promise<ScenarioReport> {
  const harness = await createHarness({
    browser,
    scenario: config.id,
    title: config.title,
    views: config.views ?? ['V1', 'V2', 'V3', 'V4', 'V5'],
    rate: config.rate,
    seed: config.seed,
  });
  try {
    await harness.begin();
    await config.body(harness);
    await harness.faults.clear();
    await harness.allConnected(60_000);
    return await harness.end(config.minimums(harness));
  } finally {
    await harness.teardown();
  }
}

/** Waits until `atMs` after the harness began. */
export async function waitUntilElapsed(harness: Harness, atMs: number): Promise<void> {
  const remaining = atMs - harness.elapsed();
  if (remaining > 0) await sleep(remaining);
}

export function printSummary(report: ScenarioReport): void {
  const lines = [
    `${report.scenario} ${report.ok ? 'PASS' : 'FAIL'} - ${report.title}`,
    `  run ${(report.timings.runMs / 1000).toFixed(0)}s, settle ${(report.timings.settleMs / 1000).toFixed(1)}s, verify ${(report.timings.verifyMs / 1000).toFixed(1)}s; driver ${report.driver.events} events, ${report.driver.ticks} ticks`,
    ...report.views.map(
      (v) => `  ${v.view}: reconnects ${v.reconnects}, deltas ${v.deltasApplied}, purges ${v.purges}, checks ${v.checks.map((c) => `${c.name}=${c.ok ? 'ok' : 'FAIL'}`).join(' ')}`,
    ),
    ...report.checks.map((c) => `  ${c.name}: ${c.ok ? 'ok' : 'FAIL'} ${JSON.stringify(c.stats)}`),
    ...report.failures.map((f) => `  ! ${f}`),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}
