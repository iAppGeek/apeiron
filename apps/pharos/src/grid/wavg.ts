import type { IAggFuncParams } from 'ag-grid-community';

/**
 * Registered as the custom `wavg` aggregation so AG Grid accepts the name. The server computes the
 * notional-weighted average, so this is never used to calculate group values.
 */
export function wavg(_params: IAggFuncParams): null {
  return null;
}
