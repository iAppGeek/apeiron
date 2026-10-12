import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = { NATS_URL: 'nats://nats:4222' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      port: 4000,
      logLevel: 'info',
      flushMs: 50,
      maxTrackedBlocks: 100,
      loadPreset: 'medium',
      storeCapacity: 1_500_000,
      natsUrl: 'nats://nats:4222',
      priceWaitMs: 10_000,
      catchupMaxPending: 100,
    });
    expect(c.viewCacheMaxBytes).toBe(384 * 1024 * 1024);
  });

  it('parses overrides, including underscores', () => {
    const c = loadConfig({
      ...base,
      PORT: '5000',
      LOG_LEVEL: 'debug',
      STORE_CAPACITY: '2_000_000',
      LOAD_PRESET: 'stress',
      PRICE_WAIT_MS: '2_500',
      CATCHUP_MAX_PENDING: '7',
    });
    expect(c).toMatchObject({ port: 5000, logLevel: 'debug', storeCapacity: 2_000_000, priceWaitMs: 2500, catchupMaxPending: 7 });
    expect(c.loadPreset).toBe('stress');
  });

  it('has no database settings: the blotter reads only from NATS', () => {
    const c = loadConfig({ ...base, MONGO_URL: 'mongodb://mongo:27017', DB_ADAPTER: 'mongo', LOAD_BATCH_SIZE: '200' });
    expect(Object.keys(c).join(' ')).not.toMatch(/mongo|dbAdapter|loadBatch/i);
  });

  it('rejects invalid values', () => {
    expect(() => loadConfig({})).toThrow(/NATS_URL/);
    expect(() => loadConfig({ NATS_URL: 'http://x' })).toThrow(/NATS_URL/);
    expect(() => loadConfig({ ...base, PORT: '70000' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...base, PRICE_WAIT_MS: '0' })).toThrow(/PRICE_WAIT_MS/);
  });
});
