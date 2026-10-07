import { colorSchemeDark, themeQuartz, type ColDef, type SideBarDef, type Theme } from 'ag-grid-community';
import { GroupLabel } from './cell-renderers';
import { wavg } from './wavg';

/** A changed cell flashes for this long, then fades; price cells keep their up or down colour for TICK_HOLD_MS. */
export const CELL_FLASH_MS = 600;
export const CELL_FADE_MS = 400;
export const TICK_HOLD_MS = 600;

export const CACHE_BLOCK_SIZE = 100;
export const MAX_BLOCKS_IN_CACHE = 20;

export const theme: Theme = themeQuartz.withPart(colorSchemeDark).withParams({
  accentColor: '#38bdf8',
  backgroundColor: '#0d1320',
  foregroundColor: '#d5dbe6',
  headerBackgroundColor: '#131b2b',
  borderColor: '#1f2a3d',
  fontSize: 12,
  headerFontSize: 12,
  spacing: 5,
});

export const defaultColDef: ColDef = {
  resizable: true,
  sortable: true,
  floatingFilter: false,
  minWidth: 70,
  suppressHeaderMenuButton: false,
  enableCellChangeFlash: true,
};

export const autoGroupColumnDef: ColDef = {
  headerName: 'Group',
  minWidth: 220,
  width: 240,
  sortable: true,
  pinned: 'left',
  // The count is drawn by GroupLabel so it gets thousands separators.
  cellRendererParams: { suppressCount: true, innerRenderer: GroupLabel },
};

export const sideBar: SideBarDef = {
  toolPanels: ['columns', 'filters'],
};

/** The server computes `wavg`; registering the name lets AG Grid accept it as an aggregation. */
export const aggFuncs = { wavg };
