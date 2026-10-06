import { describe, expect, it } from 'vitest';
import * as mnemosyne from './index.js';

describe('package entry point', () => {
  it('exports the repositories', () => {
    expect(mnemosyne).toHaveProperty('MongoOrderRepository');
    expect(mnemosyne).toHaveProperty('InMemoryOrderRepository');
    expect(mnemosyne).toHaveProperty('DEFAULT_BATCH_SIZE');
  });
});
