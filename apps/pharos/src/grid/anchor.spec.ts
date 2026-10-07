import { describe, expect, it, vi } from 'vitest';
import { planAnchor, readTopRow, type AnchorApi } from './anchor';

const api = (top: number, rowHeight: number | null | undefined = 28): AnchorApi => ({
  getVerticalPixelRange: vi.fn(() => ({ top, bottom: top + 600 })),
  getDisplayedRowAtIndex: vi.fn(() => (rowHeight === undefined ? undefined : { rowHeight })),
  ensureIndexVisible: vi.fn(),
});

describe('readTopRow', () => {
  it('is 0 at the top', () => {
    expect(readTopRow(api(0))).toBe(0);
  });

  it('divides the scroll position by the row height, to the nearest row', () => {
    expect(readTopRow(api(28 * 200))).toBe(200);
    expect(readTopRow(api(28 * 200 + 5))).toBe(200);
    expect(readTopRow(api(28 * 200 - 5))).toBe(200);
    expect(readTopRow(api(28 * 200 + 20))).toBe(201);
  });

  it('treats a sliver of scroll as the top', () => {
    expect(readTopRow(api(3))).toBe(0);
  });

  it('falls back to a default height when no row is displayed yet', () => {
    expect(readTopRow(api(280, undefined))).toBe(10);
    expect(readTopRow(api(280, null))).toBe(10);
  });

  it('is 0 for a nonsense row height', () => {
    expect(readTopRow(api(280, 0))).toBe(0);
  });
});

describe('planAnchor', () => {
  it('does nothing at the top: new rows just appear and no badge shows', () => {
    expect(planAnchor({ topRow: 0, newAbove: 5, insertedAtTop: 5 })).toEqual({ scrollToRow: null, badgeDelta: 0 });
  });

  it('scrolled down, moves down by the rows inserted above and counts them for the badge', () => {
    expect(planAnchor({ topRow: 200, newAbove: 3, insertedAtTop: 3 })).toEqual({ scrollToRow: 203, badgeDelta: 3 });
  });

  it('uses the rows actually inserted when the server reported no newAbove', () => {
    expect(planAnchor({ topRow: 4, newAbove: 0, insertedAtTop: 2 })).toEqual({ scrollToRow: 6, badgeDelta: 2 });
  });

  it('prefers the server newAbove when both are present', () => {
    expect(planAnchor({ topRow: 10, newAbove: 4, insertedAtTop: 2 })).toEqual({ scrollToRow: 14, badgeDelta: 4 });
  });

  it('does nothing when nothing arrived', () => {
    expect(planAnchor({ topRow: 50, newAbove: 0, insertedAtTop: 0 })).toEqual({ scrollToRow: null, badgeDelta: 0 });
  });
});
