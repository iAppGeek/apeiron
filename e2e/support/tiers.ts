/**
 * The three tiers of the resilience suite, from one table, so no scenario is copied per tier.
 * - quick: every scenario, shortened (the standard run, about 10 to 12 minutes);
 * - full: every scenario at its Appendix G length (releases and demos, about 28 minutes);
 * - smoke: S1 for 60 s with drops every 10 s plus S3 once (CI, about 3 minutes).
 */
export type Tier = 'quick' | 'full' | 'smoke';

export function tierFromEnv(env: Record<string, string | undefined> = process.env): Tier {
  const named = env['RESILIENCE_TIER'];
  if (named === 'quick' || named === 'full' || named === 'smoke') return named;
  return env['RESILIENCE_SMOKE'] === '1' ? 'smoke' : 'full';
}

export const TIER: Tier = tierFromEnv();

export type S1Plan = { drops: number; intervalMs: number; firstAtMs: number; shortOutages: boolean };
export type S2Plan = { durationMs: number; minReconnects: number };
export type S3Plan = { stalls: number; stallMs: number };
export type S4Plan = { downMs: number; leadMs: number; tailMs: number };
export type S5Plan = { latencyMs: number; dropsAtMs: readonly { atMs: number; kind: 'clean' | 'down3' }[]; totalMs: number };
export type S6Plan = { phase1Ms: number; phase2Ms: number };
export type S7Plan = { restarts: number; gapMs: number };

export type Plans = {
  s1: S1Plan;
  s2: S2Plan;
  s3: S3Plan;
  s4: S4Plan;
  s5: S5Plan;
  s6: S6Plan;
  s7: S7Plan;
};

export const PLANS: Readonly<Record<Tier, Plans>> = {
  full: {
    s1: { drops: 10, intervalMs: 30_000, firstAtMs: 20_000, shortOutages: false },
    s2: { durationMs: 120_000, minReconnects: 15 },
    s3: { stalls: 3, stallMs: 20_000 },
    s4: { downMs: 60_000, leadMs: 10_000, tailMs: 20_000 },
    s5: { latencyMs: 300, totalMs: 180_000, dropsAtMs: [{ atMs: 60_000, kind: 'clean' }, { atMs: 120_000, kind: 'down3' }] },
    s6: { phase1Ms: 180_000, phase2Ms: 60_000 },
    s7: { restarts: 2, gapMs: 25_000 },
  },
  quick: {
    s1: { drops: 6, intervalMs: 20_000, firstAtMs: 12_000, shortOutages: false },
    s2: { durationMs: 45_000, minReconnects: 6 },
    s3: { stalls: 1, stallMs: 20_000 },
    s4: { downMs: 30_000, leadMs: 10_000, tailMs: 15_000 },
    s5: { latencyMs: 300, totalMs: 60_000, dropsAtMs: [{ atMs: 30_000, kind: 'clean' }] },
    s6: { phase1Ms: 60_000, phase2Ms: 30_000 },
    s7: { restarts: 1, gapMs: 20_000 },
  },
  smoke: {
    s1: { drops: 5, intervalMs: 10_000, firstAtMs: 8000, shortOutages: true },
    s2: { durationMs: 45_000, minReconnects: 6 },
    s3: { stalls: 1, stallMs: 12_000 },
    s4: { downMs: 30_000, leadMs: 10_000, tailMs: 15_000 },
    s5: { latencyMs: 300, totalMs: 60_000, dropsAtMs: [{ atMs: 30_000, kind: 'clean' }] },
    s6: { phase1Ms: 60_000, phase2Ms: 30_000 },
    s7: { restarts: 1, gapMs: 20_000 },
  },
};

export const plan = (tier: Tier = TIER): Plans => PLANS[tier];

/** Scenario ids carry the tier unless it is the full run: `S1`, `S1-quick`, `S1-smoke`. */
export const scenarioId = (id: string, tier: Tier = TIER): string => (tier === 'full' ? id : `${id}-${tier}`);
