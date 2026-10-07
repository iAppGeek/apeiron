import { describe, expect, it } from 'vitest';
import { readFirstVisibleRow } from './viewport-probe';

const rect = (top: number, height: number): DOMRect => ({ top, height, bottom: top + height }) as DOMRect;

const build = (headerBottom: number, rows: [number, number, number][]): HTMLElement => {
  const root = document.createElement('div');
  const header = document.createElement('div');
  header.className = 'ag-header';
  header.getBoundingClientRect = (): DOMRect => rect(0, headerBottom);
  root.append(header);
  for (const [index, top, height] of rows) {
    const row = document.createElement('div');
    row.className = 'ag-row';
    row.setAttribute('row-index', String(index));
    row.getBoundingClientRect = (): DOMRect => rect(top, height);
    root.append(row);
  }
  return root;
};

describe('readFirstVisibleRow', () => {
  it('is null without a grid or a header', () => {
    expect(readFirstVisibleRow(null)).toBeNull();
    expect(readFirstVisibleRow(document.createElement('div'))).toBeNull();
  });

  it('is null when no rows are rendered', () => {
    expect(readFirstVisibleRow(build(100, []))).toBeNull();
  });

  it('picks the first row that starts at or below the header', () => {
    const root = build(100, [
      [4, 36, 32],
      [5, 68, 32],
      [6, 100, 32],
      [7, 132, 32],
    ]);
    expect(readFirstVisibleRow(root)).toBe(6);
  });

  it('counts a row at the top that is at least half visible, and skips one that is mostly hidden', () => {
    expect(readFirstVisibleRow(build(100, [[10, 90, 32], [11, 122, 32]]))).toBe(10);
    expect(readFirstVisibleRow(build(100, [[10, 85, 32], [11, 117, 32]]))).toBe(10);
    expect(readFirstVisibleRow(build(100, [[10, 70, 32], [11, 102, 32]]))).toBe(11);
  });

  it('takes the lowest index when pinned and centre containers both render the row', () => {
    expect(readFirstVisibleRow(build(100, [[3, 100, 32], [3, 100, 32], [4, 132, 32]]))).toBe(3);
  });

  it('ignores rows without a height', () => {
    expect(readFirstVisibleRow(build(100, [[3, 100, 0], [4, 132, 32]]))).toBe(4);
  });
});
