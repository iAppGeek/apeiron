import type { ColDef, SetFilterValuesFuncParams, ValueFormatterParams } from 'ag-grid-community';
import type { ColumnMeta } from '@apeiron/logos';
import { StatusChip, sideCellClass } from './cell-renderers';
import { formatCell } from './formatters';

/** Aggregate names the server accepts on the wire. */
export type WireAggFunc = 'sum' | 'avg' | 'count' | 'wavg';

export const ALLOWED_AGG_FUNCS: readonly WireAggFunc[] = ['sum', 'avg', 'count', 'wavg'];

/** `wavg:notionalUsd` is the metadata spelling; on the wire it is `wavg` (always weighted by notional). */
export function toWireAggFunc(aggFunc: NonNullable<ColumnMeta['aggFunc']>): WireAggFunc {
  return aggFunc === 'wavg:notionalUsd' ? 'wavg' : aggFunc;
}

export type ColumnDefDeps = {
  /** Fetches the distinct values for a set filter, scoped to the current trader. */
  fetchFilterValues: (colId: string) => Promise<string[]>;
};

/** The status chip (PENDING_START) needs more room than the metadata width. */
export const STATUS_MIN_WIDTH = 160;

/** Room for the sort, filter and menu icons next to a header label. */
const HEADER_ICONS_WIDTH = 64;
const HEADER_CHAR_WIDTH = 7;

/** Smallest width at which the whole header label fits beside its icons. */
export function headerMinWidth(header: string): number {
  return Math.ceil(header.length * HEADER_CHAR_WIDTH + HEADER_ICONS_WIDTH);
}

/** Header text; datetimes display in UTC, so say so. */
export function headerLabel(meta: ColumnMeta): string {
  return meta.type === 'datetime' ? `${meta.header} (UTC)` : meta.header;
}

const FILTERS = {
  text: 'agTextColumnFilter',
  set: 'agSetColumnFilter',
  number: 'agNumberColumnFilter',
  date: 'agDateColumnFilter',
} as const;

function filterParamsFor(meta: ColumnMeta, deps: ColumnDefDeps): ColDef['filterParams'] {
  switch (meta.filter) {
    case 'set':
      return {
        values: (params: SetFilterValuesFuncParams): void => {
          deps.fetchFilterValues(meta.field).then(
            (values) => {
              params.success(values);
            },
            () => {
              params.success([]);
            },
          );
        },
        // The value list depends on the trader scope, so reload it each time the filter opens.
        refreshValuesOnOpen: true,
      };
    case 'number':
      return { inRangeInclusive: true, debounceMs: 300 };
    case 'date':
      return { inRangeInclusive: true };
    case 'text':
      return { debounceMs: 300 };
  }
}

/** Builds the AG Grid column definition for one column of the shared metadata. */
export function buildColumnDef(meta: ColumnMeta, deps: ColumnDefDeps): ColDef {
  const headerName = headerLabel(meta);
  const minWidth = headerMinWidth(headerName);
  const baseWidth = meta.field === 'status' ? Math.max(meta.width ?? 0, STATUS_MIN_WIDTH) : (meta.width ?? 120);
  const def: ColDef = {
    colId: meta.field,
    field: meta.field,
    headerName,
    headerTooltip: headerName,
    minWidth,
    width: Math.max(baseWidth, minWidth),
    filter: FILTERS[meta.filter],
    filterParams: filterParamsFor(meta, deps),
    enableRowGroup: meta.groupable,
    valueFormatter: (params: ValueFormatterParams): string => formatCell(meta, params.value, params.data),
  };

  if (meta.type === 'number') def.type = 'numericColumn';
  if (meta.aggFunc !== undefined) {
    def.aggFunc = toWireAggFunc(meta.aggFunc);
    def.allowedAggFuncs = [...ALLOWED_AGG_FUNCS];
    def.enableValue = true;
  }
  if (meta.field === 'status') def.cellRenderer = StatusChip;
  if (meta.field === 'side') def.cellClass = sideCellClass;
  if (meta.field === 'createdAt') def.sort = 'desc';
  if (meta.field === 'orderId') def.pinned = 'left';
  return def;
}

export function buildColumnDefs(columns: readonly ColumnMeta[], deps: ColumnDefDeps): ColDef[] {
  return columns.map((meta) => buildColumnDef(meta, deps));
}
