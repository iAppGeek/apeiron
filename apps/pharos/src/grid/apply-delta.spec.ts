import type { GridApi } from 'ag-grid-community';
import { describe, expect, it, vi } from 'vitest';
import { applyDelta, type DeltaMsg } from './apply-delta';

describe('applyDelta', () => {
  it('leaves the grid untouched until phase 5 applies transactions', () => {
    const api = { applyServerSideTransaction: vi.fn(), refreshServerSide: vi.fn() };
    const delta: DeltaMsg = {
      t: 'delta',
      seq: 1,
      serverTs: 0,
      updates: [],
      groupUpdates: [],
      adds: [],
      dirtyRoutes: [],
      rowCounts: [],
      newAbove: 0,
    };
    applyDelta(api as unknown as GridApi, delta);
    expect(api.applyServerSideTransaction).not.toHaveBeenCalled();
    expect(api.refreshServerSide).not.toHaveBeenCalled();
  });
});
