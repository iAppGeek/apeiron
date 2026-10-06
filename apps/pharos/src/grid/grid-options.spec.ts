import { describe, expect, it } from 'vitest';
import {
  CACHE_BLOCK_SIZE,
  MAX_BLOCKS_IN_CACHE,
  aggFuncs,
  autoGroupColumnDef,
  sideBar,
  theme,
} from './grid-options';
import { GroupLabel } from './cell-renderers';
import { wavg } from './wavg';

describe('grid options', () => {
  it('uses the plan block sizes', () => {
    expect(CACHE_BLOCK_SIZE).toBe(100);
    expect(MAX_BLOCKS_IN_CACHE).toBe(20);
  });

  it('registers the custom wavg aggregate', () => {
    expect(aggFuncs).toEqual({ wavg });
  });

  it('has a side bar with the columns and filters panels', () => {
    expect(sideBar).toEqual({ toolPanels: ['columns', 'filters'] });
  });

  it('has a dark quartz theme and a group column', () => {
    expect(theme).toBeDefined();
    expect(autoGroupColumnDef.headerName).toBe('Group');
    expect(autoGroupColumnDef.cellRendererParams).toEqual({ suppressCount: true, innerRenderer: GroupLabel });
  });
});
