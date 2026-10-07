import {
  CellStyleModule,
  ColumnApiModule,
  DateFilterModule,
  HighlightChangesModule,
  NumberFilterModule,
  RenderApiModule,
  RowApiModule,
  ScrollApiModule,
  TextFilterModule,
  TooltipModule,
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
 * plus what the UI strictly needs: header tooltips, the group panel, side bar with its two tool panels, and the column menu.
 * Phase 5b adds HighlightChanges (cell flash) and the row, scroll and render api modules the live client calls
 * (`getRowNode`, `ensureIndexVisible`, `getVerticalPixelRange`, `refreshCells`).
 * ContextMenu arrives with phase 6 (the status bar is app-level).
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
  HighlightChangesModule,
  RenderApiModule,
  RowApiModule,
  ScrollApiModule,
  TooltipModule,
  ColumnMenuModule,
  SideBarModule,
  ColumnsToolPanelModule,
  FiltersToolPanelModule,
];
