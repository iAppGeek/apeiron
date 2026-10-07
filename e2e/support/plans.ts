import type { Faults } from './faults';

export type DropKind = 'clean' | 'down3' | 'down10';
export const DROP_ROTATION: readonly DropKind[] = ['clean', 'down3', 'down10'];

export type ScheduledDrop = { atMs: number; kind: DropKind };

/** `count` drops, `intervalMs` apart from `firstAtMs`, rotating clean / proxy down 3s / proxy down 10s. */
export function dropSchedule(count: number, intervalMs: number, firstAtMs: number): ScheduledDrop[] {
  return Array.from({ length: count }, (_, i) => ({
    atMs: firstAtMs + i * intervalMs,
    kind: DROP_ROTATION[i % DROP_ROTATION.length] as DropKind,
  }));
}

export type DownDurations = Readonly<Record<Exclude<DropKind, 'clean'>, number>>;
export const DOWN_MS: DownDurations = { down3: 3000, down10: 10_000 };
/** The smoke run's cadence is 10 s, so its outages are shorter. */
export const SMOKE_DOWN_MS: DownDurations = { down3: 2000, down10: 5000 };

/** Performs one drop and returns when the proxy is passing traffic again. */
export async function performDrop(faults: Faults, kind: DropKind, down: DownDurations = DOWN_MS): Promise<void> {
  if (kind === 'clean') await faults.dropClean();
  else await faults.down(down[kind]);
}

/** A seeded, repeatable pick of `min..max` (inclusive) for flapping intervals. */
export function pickBetween(rng: () => number, min: number, max: number): number {
  return Math.round(min + rng() * (max - min));
}
