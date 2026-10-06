import {
  CellStyleModule,
  ColumnApiModule,
  DateFilterModule,
  NumberFilterModule,
  TextFilterModule,
  type Module,
} from 'ag-grid-community';
import {
  ColumnMenuModule,
  ColumnsToolPanelModule,
  FiltersToolPanelModule,
  RowGroupingModule,
  RowGroupingPanelModule,
  ServerSideRowModelApiModule,
  ServerSideRowModelModule,
  SetFilterModule,
  SideBarModule,
} from 'ag-grid-enterprise';

/**
 * Appendix A modules for this phase (server-side row model, grouping, the four filters, cell style),
 * plus what the UI strictly needs: the group panel, side bar with its two tool panels, and the column menu.
 * ContextMenu, HighlightChanges and StatusBar arrive with phases 5 and 6 (the status bar is app-level).
 */
export const GRID_MODULES: Module[] = [
  ServerSideRowModelModule,
  ServerSideRowModelApiModule,
  RowGroupingModule,
  RowGroupingPanelModule,
  SetFilterModule,
  TextFilterModule,
  NumberFilterModule,
  DateFilterModule,
  CellStyleModule,
  ColumnApiModule,
  ColumnMenuModule,
  SideBarModule,
  ColumnsToolPanelModule,
  FiltersToolPanelModule,
];
