import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = { NATS_URL: 'nats://nats:4222' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig(base)).toEqual({ natsUrl: 'nats://nats:4222', logLevel: 'info', seed: undefined, healthPort: 4300, refMidsWaitMs: 10_000 });
  });

  it('reads overrides', () => {
    expect(loadConfig({ ...base, HELIOS_SEED: '7', HEALTH_PORT: '4301', LOG_LEVEL: 'debug', REF_MIDS_WAIT_MS: '2_000' })).toMatchObject({
      seed: 7,
      healthPort: 4301,
      logLevel: 'debug',
      refMidsWaitMs: 2000,
    });
  });

  it('rejects missing or invalid values', () => {
    expect(() => loadConfig({})).toThrow(/Invalid configuration/);
    expect(() => loadConfig({ NATS_URL: 'http://x' })).toThrow(/NATS_URL/);
    expect(() => loadConfig({ ...base, HELIOS_SEED: 'abc' })).toThrow(/HELIOS_SEED/);
    expect(() => loadConfig({ ...base, HEALTH_PORT: '99999' })).toThrow(/HEALTH_PORT/);
  });
});
