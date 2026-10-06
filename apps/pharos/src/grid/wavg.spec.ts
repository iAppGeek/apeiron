import type { IAggFuncParams } from 'ag-grid-community';
import { describe, expect, it } from 'vitest';
import { wavg } from './wavg';

describe('wavg', () => {
  it('is a placeholder aggregate: the server computes the value', () => {
    expect(wavg({ values: [1, 2, 3] } as unknown as IAggFuncParams)).toBeNull();
  });
});
