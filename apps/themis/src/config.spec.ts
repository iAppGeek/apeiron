import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = { MONGO_URL: 'mongodb://mongo:27017', NATS_URL: 'nats://nats:4222' };

describe('loadConfig', () => {
  it('applies the documented defaults', () => {
    expect(loadConfig(base)).toEqual({
      mongoUrl: 'mongodb://mongo:27017',
      mongoDb: 'blotter',
      natsUrl: 'nats://nats:4222',
      logLevel: 'info',
      healthPort: 4200,
      groupCommitMs: 20,
      groupCommitMax: 500,
      venueTimeoutMs: 5000,
      reconcileWindowMin: 15,
      rebuildProjection: false,
    });
  });

  it('reads overrides, including digit separators', () => {
    const cfg = loadConfig({ ...base, GROUP_COMMIT_MS: '10', GROUP_COMMIT_MAX: '1_000', REBUILD_PROJECTION: '1', HEALTH_PORT: '4201', LOG_LEVEL: 'debug' });
    expect(cfg).toMatchObject({ groupCommitMs: 10, groupCommitMax: 1000, rebuildProjection: true, healthPort: 4201, logLevel: 'debug' });
  });

  it('rejects missing or invalid values', () => {
    expect(() => loadConfig({})).toThrow(/Invalid configuration/);
    expect(() => loadConfig({ ...base, NATS_URL: 'http://x' })).toThrow(/NATS_URL/);
    expect(() => loadConfig({ ...base, REBUILD_PROJECTION: 'yes' })).toThrow(/REBUILD_PROJECTION/);
    expect(() => loadConfig({ ...base, GROUP_COMMIT_MS: '0' })).toThrow(/GROUP_COMMIT_MS/);
    expect(() => loadConfig({ ...base, HEALTH_PORT: '99999' })).toThrow(/HEALTH_PORT/);
  });
});
