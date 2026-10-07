import { describe, expect, it } from 'vitest';
import {
  CACHE_BLOCK_SIZE,
  CELL_FADE_MS,
  CELL_FLASH_MS,
  MAX_BLOCKS_IN_CACHE,
  TICK_HOLD_MS,
  aggFuncs,
  autoGroupColumnDef,
  defaultColDef,
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

  it('flashes changed cells for about 600ms and holds the price colour as long', () => {
    expect(defaultColDef.enableCellChangeFlash).toBe(true);
    expect(CELL_FLASH_MS).toBe(600);
    expect(TICK_HOLD_MS).toBe(600);
    expect(CELL_FADE_MS).toBeGreaterThan(0);
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
