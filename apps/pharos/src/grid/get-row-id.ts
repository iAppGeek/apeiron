import type { GetRowIdParams } from 'ag-grid-community';

export type RowIdInput = {
  data: Record<string, unknown>;
  parentKeys?: readonly string[];
  level: number;
  /** Fields of the active row-group columns, outermost first. */
  groupFields: readonly (string | undefined)[];
};

/**
 * Appendix B row ids, the same rule the server uses. Leaf rows are their `orderId`; group rows are
 * `"G:" + [...parentKeys, key].join("|")`, where the key is the group column's value on the row.
 */
export function computeRowId({ data, parentKeys, level, groupFields }: RowIdInput): string {
  const orderId = data['orderId'];
  if (typeof orderId === 'string') return orderId;
  const field = groupFields[level];
  const key = field === undefined ? undefined : data[field];
  return `G:${[...(parentKeys ?? []), String(key ?? '')].join('|')}`;
}

/** AG Grid `getRowId` callback. */
export function getRowId(params: GetRowIdParams): string {
  const groupFields = params.api.getRowGroupColumns().map((col) => col.getColDef().field);
  return computeRowId({
    data: params.data as Record<string, unknown>,
    parentKeys: params.parentKeys,
    level: params.level,
    groupFields,
  });
}
