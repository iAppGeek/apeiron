import { colorSchemeDark, themeQuartz, type ColDef, type SideBarDef, type Theme } from 'ag-grid-community';
import { wavg } from './wavg';

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
};

export const autoGroupColumnDef: ColDef = {
  headerName: 'Group',
  minWidth: 220,
  width: 240,
  sortable: true,
  pinned: 'left',
};

export const sideBar: SideBarDef = {
  toolPanels: ['columns', 'filters'],
};

/** The server computes `wavg`; registering the name lets AG Grid accept it as an aggregation. */
export const aggFuncs = { wavg };

/** Group rows carry the server's `childCount`; the group cell shows it as `(n)`. */
export function getChildCount(data: unknown): number {
  const count = typeof data === 'object' && data !== null ? (data as { childCount?: unknown }).childCount : undefined;
  return typeof count === 'number' ? count : 0;
}
