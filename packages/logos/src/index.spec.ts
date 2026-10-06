import { describe, expect, it } from 'vitest';
import * as logos from './index.js';

describe('package entry point', () => {
  it('exports the public API', () => {
    for (const name of [
      'COLUMNS',
      'COLUMNS_VERSION',
      'PAIRS',
      'TRADERS',
      'mulberry32',
      'generateOrderBatches',
      'generateOrders',
      'parseClientMsg',
      'clientMsgSchema',
      'jsonCodec',
      'msgpackCodec',
      'getCodec',
    ]) {
      expect(logos).toHaveProperty(name);
    }
  });
});
