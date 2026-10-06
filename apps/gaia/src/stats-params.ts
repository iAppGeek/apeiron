export type StatsParams = { seed: number; rows: number; now: number };

/** Reads SEED, SEED_ROWS and SEED_NOW (ISO) for the stats command, with the same defaults as the seeder. */
export function loadStatsParams(env: Record<string, string | undefined>): StatsParams {
  const int = (value: string | undefined, fallback: number): number => {
    if (value === undefined || value === '') return fallback;
    const n = Number(value.replaceAll('_', ''));
    if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid integer: ${value}`);
    return n;
  };
  const nowRaw = env.SEED_NOW;
  const now = nowRaw === undefined || nowRaw === '' ? Date.now() : Date.parse(nowRaw);
  if (Number.isNaN(now)) throw new Error(`Invalid SEED_NOW: ${nowRaw}`);
  return { seed: int(env.SEED, 42), rows: int(env.SEED_ROWS, 1_000_000), now };
}
