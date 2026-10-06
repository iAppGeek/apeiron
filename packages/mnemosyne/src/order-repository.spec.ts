import { describe, expect, it } from 'vitest';
import { DEFAULT_BATCH_SIZE } from './order-repository.js';

describe('order-repository', () => {
  it('defaults to 10k batches', () => {
    expect(DEFAULT_BATCH_SIZE).toBe(10_000);
  });
});
