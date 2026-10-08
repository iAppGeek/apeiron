import { describe, expect, it } from 'vitest';
import { PLANS, scenarioId, tierFromEnv } from './tiers';

describe('tierFromEnv', () => {
  it('prefers RESILIENCE_TIER, honours the old smoke flag, and defaults to full', () => {
    expect(tierFromEnv({ RESILIENCE_TIER: 'quick' })).toBe('quick');
    expect(tierFromEnv({ RESILIENCE_TIER: 'smoke', RESILIENCE_SMOKE: '0' })).toBe('smoke');
    expect(tierFromEnv({ RESILIENCE_SMOKE: '1' })).toBe('smoke');
    expect(tierFromEnv({ RESILIENCE_TIER: 'bogus' })).toBe('full');
    expect(tierFromEnv({})).toBe('full');
  });
});

describe('PLANS', () => {
  it('matches the agreed shapes', () => {
    expect(PLANS.quick.s1).toMatchObject({ drops: 6, intervalMs: 20_000 });
    expect(PLANS.quick.s3).toEqual({ stalls: 1, stallMs: 20_000 });
    expect(PLANS.full.s1.drops).toBe(10);
    expect(PLANS.smoke.s1).toMatchObject({ drops: 5, intervalMs: 10_000 });
  });

  it('never gets a tier past its own length: drops and restarts fit inside the run', () => {
    for (const p of Object.values(PLANS)) {
      expect(p.s5.dropsAtMs.every((d) => d.atMs < p.s5.totalMs)).toBe(true);
      expect(p.s1.drops).toBeGreaterThan(0);
      expect(p.s7.restarts).toBeGreaterThan(0);
      expect(p.s6.phase2Ms).toBeGreaterThan(0);
    }
  });
});

describe('scenarioId', () => {
  it('suffixes every tier but full', () => {
    expect(scenarioId('S1', 'full')).toBe('S1');
    expect(scenarioId('S1', 'quick')).toBe('S1-quick');
    expect(scenarioId('S3', 'smoke')).toBe('S3-smoke');
  });
});
