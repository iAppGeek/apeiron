import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig({ MONGO_URL: 'mongodb://localhost:27017' })).toEqual({
      mongoUrl: 'mongodb://localhost:27017',
      mongoDb: 'blotter',
      rows: 1_000_000,
      seed: 42,
      now: undefined,
      batchSize: 10_000,
      reset: false,
    });
  });

  it('parses overrides, underscores and SEED_NOW', () => {
    const cfg = loadConfig({
      MONGO_URL: 'mongodb://mongo:27017',
      MONGO_DB: 'x',
      SEED_ROWS: '2_000',
      SEED: '7',
      SEED_NOW: '2026-10-06T12:00:00Z',
      BATCH_SIZE: '500',
      SEED_RESET: 'true',
    });
    expect(cfg).toMatchObject({ mongoDb: 'x', rows: 2000, seed: 7, now: Date.UTC(2026, 9, 6, 12), batchSize: 500, reset: true });
  });

  it('treats an empty SEED_NOW as unset', () => {
    expect(loadConfig({ MONGO_URL: 'mongodb://h', SEED_NOW: '' }).now).toBeUndefined();
  });

  it('rejects missing or invalid values with a readable message', () => {
    expect(() => loadConfig({})).toThrow(/MONGO_URL/);
    expect(() => loadConfig({ MONGO_URL: 'http://nope' })).toThrow(/MONGO_URL/);
    expect(() => loadConfig({ MONGO_URL: 'mongodb://h', SEED_ROWS: '-5' })).toThrow(/SEED_ROWS/);
    expect(() => loadConfig({ MONGO_URL: 'mongodb://h', SEED_ROWS: 'abc' })).toThrow(/SEED_ROWS/);
    expect(() => loadConfig({ MONGO_URL: 'mongodb://h', SEED_NOW: 'yesterday' })).toThrow(/SEED_NOW/);
    expect(() => loadConfig({ MONGO_URL: 'mongodb://h', SEED_RESET: 'yes' })).toThrow(/SEED_RESET/);
  });
});
