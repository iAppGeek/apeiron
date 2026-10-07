/**
 * Reads the first row the user can see straight from the rendered rows. AG Grid has no public call for it:
 * `getFirstDisplayedRowIndex` includes the buffer, and the scroll position cannot be divided by the row height
 * because with a million rows the grid scales it. A rendered row is at the top when at least half of it is
 * inside the viewport, which gives the nearest whole row however the scroll position is rounded.
 */
export function readFirstVisibleRow(root: ParentNode | null): number | null {
  if (root === null) return null;
  const header = root.querySelector('.ag-header');
  if (header === null) return null;
  const bodyTop = header.getBoundingClientRect().bottom;
  let best: number | null = null;
  for (const row of root.querySelectorAll('.ag-row[row-index]')) {
    const rect = row.getBoundingClientRect();
    if (rect.height <= 0 || rect.top < bodyTop - rect.height / 2) continue;
    const index = Number(row.getAttribute('row-index'));
    if (Number.isFinite(index) && (best === null || index < best)) best = index;
  }
  return best;
}
