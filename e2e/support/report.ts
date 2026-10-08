import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Check } from './oracle';
import type { DriverStats } from './driver';

export type LatencySummary = {
  samples: number;
  /** Median of the rolling p50 / p95 figures the page published once a second. */
  p50MedianMs: number | null;
  p95MedianMs: number | null;
  p95MaxMs: number | null;
};

export type ViewReport = {
  view: string;
  reconnects: number;
  deltasApplied: number;
  rowsUpdated: number;
  /** Updates the server sent for rows the page did not hold. */
  skipped: number;
  purges: number;
  lastCloseReason: string | null;
  /** Every close reason and every toast the page showed, so a failure can be traced to what the user was told. */
  closeHistory: string[];
  toasts: string[];
  latency: LatencySummary;
  checks: Check[];
};

export type ScenarioReport = {
  scenario: string;
  /** quick, full or smoke (support/tiers.ts). */
  tier: string;
  title: string;
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  timings: { runMs: number; settleMs: number; verifyMs: number; totalMs: number };
  rate: string;
  seed: number;
  driver: DriverStats;
  /** Faults applied, in order, with the time they started (ms from the start of the run). */
  faults: { kind: string; atMs: number; detail?: string }[];
  /** Scenario-specific measurements, such as the time to detect a stall. */
  measurements: Record<string, number | string | number[]>;
  views: ViewReport[];
  checks: Check[];
  failures: string[];
};

const percentile = (sorted: readonly number[], p: number): number | null => {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? null;
};

/** Summarises the once-a-second figures a page published. */
export function summariseLatency(samples: readonly { p50: number | null; p95: number | null }[]): LatencySummary {
  const p50 = samples.flatMap((s) => (s.p50 === null ? [] : [s.p50])).sort((a, b) => a - b);
  const p95 = samples.flatMap((s) => (s.p95 === null ? [] : [s.p95])).sort((a, b) => a - b);
  return {
    samples: p95.length,
    p50MedianMs: percentile(p50, 0.5),
    p95MedianMs: percentile(p95, 0.5),
    p95MaxMs: p95.at(-1) ?? null,
  };
}

/** A scenario passes when every check passed. */
export function failuresOf(views: readonly ViewReport[], checks: readonly Check[]): string[] {
  const out: string[] = [];
  for (const view of views) {
    for (const check of view.checks) if (!check.ok) out.push(`${view.view} ${check.name}: ${check.failures.slice(0, 3).join(' | ')}`);
  }
  for (const check of checks) if (!check.ok) out.push(`${check.name}: ${check.failures.slice(0, 3).join(' | ')}`);
  return out;
}

export const resultsDir = (): string => new URL('../results/', import.meta.url).pathname;

export function resultFileName(scenario: string, at: Date): string {
  return `${scenario}-${at.toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, 'Z')}.json`;
}

/** Writes `e2e/results/<scenario>-<timestamp>.json` (gitignored) and returns its path. */
export function writeReport(report: ScenarioReport, dir: string = resultsDir()): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, resultFileName(report.scenario, new Date(report.startedAt)));
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}
