/** The part of the grid api the anchor needs, so it can be faked in tests. */
export type AnchorApi = {
  getVerticalPixelRange(): { top: number; bottom: number };
  getDisplayedRowAtIndex(index: number): { rowHeight?: number | null } | undefined;
  ensureIndexVisible(index: number, position?: 'top' | 'bottom' | 'middle' | null): void;
};

const FALLBACK_ROW_HEIGHT = 28;

/**
 * The row index at the top of the viewport, to the nearest whole row. Unlike `getFirstDisplayedRowIndex`
 * this ignores the rows AG Grid renders above the viewport as a buffer, so 0 really means the top.
 */
export function readTopRow(api: AnchorApi): number {
  const top = api.getVerticalPixelRange().top;
  if (top <= 0) return 0;
  const rowHeight = api.getDisplayedRowAtIndex(0)?.rowHeight ?? FALLBACK_ROW_HEIGHT;
  return rowHeight > 0 ? Math.round(top / rowHeight) : 0;
}

export type AnchorInput = {
  /** Top row before the rows were inserted. */
  topRow: number;
  /** The delta's `newAbove`: rows inserted above what the client was looking at. */
  newAbove: number;
  /** Rows the grid actually inserted at the top of the root route. */
  insertedAtTop: number;
};

export type AnchorPlan = {
  /** Row to scroll to, putting the same orders back at the top of the viewport; null when nothing needs to move. */
  scrollToRow: number | null;
  /** How many new orders to add to the badge. */
  badgeDelta: number;
};

/**
 * At the top the new rows just appear. Scrolled down, the rows the user was looking at moved down by the number
 * of rows inserted above them, so scroll down by the same amount and count them for the badge. The delta's
 * `newAbove` is authoritative; the rows actually inserted cover a server that last saw block 0 as the top.
 */
export function planAnchor({ topRow, newAbove, insertedAtTop }: AnchorInput): AnchorPlan {
  const shift = newAbove > 0 ? newAbove : insertedAtTop;
  if (topRow <= 0 || shift <= 0) return { scrollToRow: null, badgeDelta: 0 };
  return { scrollToRow: topRow + shift, badgeDelta: shift };
}
