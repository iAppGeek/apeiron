import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = { MONGO_URL: 'mongodb://mongo:27017', NATS_URL: 'nats://nats:4222' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig(base)).toEqual({
      mongoUrl: 'mongodb://mongo:27017',
      mongoDb: 'blotter',
      natsUrl: 'nats://nats:4222',
      loadPreset: 'medium',
      logLevel: 'info',
      seed: undefined,
      healthPort: 4100,
      stepMs: 100,
    });
  });

  it('reads overrides', () => {
    const cfg = loadConfig({ ...base, LOAD_PRESET: 'stress', HERMES_SEED: '7', HEALTH_PORT: '4200', STEP_MS: '50', LOG_LEVEL: 'debug' });
    expect(cfg).toMatchObject({ loadPreset: 'stress', seed: 7, healthPort: 4200, stepMs: 50, logLevel: 'debug' });
  });

  it('rejects missing or invalid values', () => {
    expect(() => loadConfig({})).toThrow(/Invalid configuration/);
    expect(() => loadConfig({ ...base, LOAD_PRESET: 'huge' })).toThrow(/LOAD_PRESET/);
    expect(() => loadConfig({ ...base, NATS_URL: 'http://x' })).toThrow(/NATS_URL/);
    expect(() => loadConfig({ ...base, HERMES_SEED: 'abc' })).toThrow(/HERMES_SEED/);
    expect(() => loadConfig({ ...base, HEALTH_PORT: '99999' })).toThrow(/HEALTH_PORT/);
  });
});
