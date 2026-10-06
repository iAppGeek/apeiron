import { describe, expect, it } from 'vitest';
import { sampleClientMsgs, sampleMessages, sampleOrders, sampleServerMsgs } from './fixtures.js';

describe('fixtures', () => {
  it('builds deterministic samples', () => {
    expect(sampleOrders(5)).toEqual(sampleOrders(5));
    expect(sampleOrders(5)).toHaveLength(5);
    expect(sampleMessages()).toHaveLength(sampleClientMsgs().length + sampleServerMsgs().length);
  });
});
