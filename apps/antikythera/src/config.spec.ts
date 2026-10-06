import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({ MONGO_URL: 'mongodb://mongo:27017' });
    expect(c).toMatchObject({
      mongoDb: 'blotter',
      dbAdapter: 'mongo',
      port: 4000,
      logLevel: 'info',
      flushMs: 100,
      writeBehindMs: 500,
      maxTrackedBlocks: 100,
      loadPreset: 'medium',
      storeCapacity: 1_500_000,
      natsUrl: undefined,
    });
    expect(c.viewCacheMaxBytes).toBe(384 * 1024 * 1024);
  });

  it('parses overrides, including underscores', () => {
    const c = loadConfig({
      MONGO_URL: 'mongodb://h:1',
      MONGO_DB: 'x',
      PORT: '5000',
      LOG_LEVEL: 'debug',
      NATS_URL: 'nats://nats:4222',
      STORE_CAPACITY: '2_000_000',
      LOAD_PRESET: 'stress',
    });
    expect(c).toMatchObject({ mongoDb: 'x', port: 5000, logLevel: 'debug', storeCapacity: 2_000_000 });
    expect(c.natsUrl).toBe('nats://nats:4222');
    expect(c.loadPreset).toBe('stress');
  });

  it('rejects invalid values', () => {
    expect(() => loadConfig({})).toThrow(/MONGO_URL/);
    expect(() => loadConfig({ MONGO_URL: 'http://x' })).toThrow(/MONGO_URL/);
    expect(() => loadConfig({ MONGO_URL: 'mongodb://h', DB_ADAPTER: 'oracle' })).toThrow(/DB_ADAPTER/);
    expect(() => loadConfig({ MONGO_URL: 'mongodb://h', PORT: '70000' })).toThrow(/PORT/);
    expect(() => loadConfig({ MONGO_URL: 'mongodb://h', PORT: 'abc' })).toThrow(/PORT/);
  });
});
