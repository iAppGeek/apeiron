import { expect, test } from '@playwright/test';
import { Blotter, ROW_HEIGHT } from '../support/blotter';

test.describe('live updates', () => {
  test('a LIVE row ticks: its price cells flash and change value', async ({ page }) => {
    const blotter = new Blotter(page);
    await blotter.open();

    // Only LIVE orders tick, and what is on top depends on what the stack has just been doing (a stress run leaves
    // hundreds of orders still pending), so show LIVE orders only.
    await blotter.filterSet('status', 'LIVE');
    await expect.poll(async () => (await blotter.rowIdsWithStatus('LIVE')).length, { message: 'a LIVE row on screen' }).toBeGreaterThan(0);
    const [liveId] = await blotter.rowIdsWithStatus('LIVE');
    await blotter.revealColumn('marketMid');
    const mid = blotter.cell(blotter.rowById(liveId ?? ''), 'marketMid');
    const initial = await mid.innerText();
    await expect(mid).not.toHaveText(initial, { timeout: 30_000 });

    // The change flashes (AG Grid's change flash) and the cell is coloured up or down while it is fresh.
    await expect
      .poll(() => page.locator('.ag-cell.ag-cell-data-changed, .ag-cell.ag-cell-data-changed-animation').count(), {
        message: 'a flashing cell',
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    await expect(page.locator('.ag-cell.tick-up, .ag-cell.tick-down').first()).toBeVisible({ timeout: 30_000 });
  });

  test('a new order arrives at the top of the default view', async ({ page }) => {
    const blotter = new Blotter(page);
    await blotter.open();
    const before = await blotter.firstRowId();
    expect(before).not.toBeNull();

    await expect.poll(() => blotter.firstRowId(), { message: 'a new first row', timeout: 60_000 }).not.toBe(before);
    const after = (await blotter.firstRowId()) ?? '';
    expect(after > (before ?? '')).toBe(true);
    // The old first row was pushed down, not replaced.
    await expect(blotter.rowById(before ?? '')).not.toHaveAttribute('row-index', '0');
    // At the top there is nothing hidden above the viewport, so no badge.
    await expect(blotter.badge).toBeHidden();
  });

  test('scrolled down: the same orders stay in place while the badge counts new ones', async ({ page }) => {
    const blotter = new Blotter(page);
    await blotter.open();
    await blotter.scrollDownRows(5000);
    const anchor = await blotter.topVisibleRow();

    // Once the first new orders have landed the viewport has been moved back over the anchor: note where it rests.
    await expect.poll(() => blotter.badgeCount(), { message: 'the badge appears', timeout: 60_000 }).toBeGreaterThan(2);
    const resting = await blotter.restingOffset(anchor.rowId);
    expect(resting).toBeGreaterThanOrEqual(-ROW_HEIGHT);
    expect(resting).toBeLessThan(2 * ROW_HEIGHT);

    // Then ten more orders arrive above it and it has not moved: not by a pixel, let alone by a row.
    const counted = await blotter.badgeCount();
    await expect.poll(() => blotter.badgeCount(), { message: 'more orders arrive above', timeout: 60_000 }).toBeGreaterThan(counted + 9);
    await expect
      .poll(async () => Math.abs((await blotter.restingOffset(anchor.rowId)) - resting), { message: 'the anchored order stays put' })
      .toBeLessThanOrEqual(2);

    // Clicking the badge goes back to the top and clears it.
    await blotter.badge.click();
    await expect(blotter.badge).toBeHidden();
    await expect.poll(() => blotter.scroller.evaluate((el) => el.scrollTop)).toBe(0);
    await expect(blotter.rowAt(0)).toBeVisible();
  });

  test('anchoring also holds under a non-default sort (the storeRefreshed path)', async ({ page }) => {
    // Watch the wire: under this sort the server must announce the new orders as a dirty root route, not as adds.
    const deltas: { adds: unknown[]; dirtyRoutes: unknown[]; newAbove: number }[] = [];
    page.on('websocket', (socket) => {
      socket.on('framereceived', ({ payload }) => {
        if (typeof payload !== 'string') return;
        const message: unknown = JSON.parse(payload);
        if (typeof message === 'object' && message !== null && (message as { t?: unknown }).t === 'delta') {
          deltas.push(message as { adds: unknown[]; dirtyRoutes: unknown[]; newAbove: number });
        }
      });
    });
    const blotter = new Blotter(page);
    await blotter.open();
    // New orders have the highest order ids, so Order ID descending still puts them on top, but the view is no
    // longer createdAt descending: they arrive with a background refresh and the anchor waits for storeRefreshed.
    await blotter.sort('orderId', 'desc');
    await blotter.scrollDownRows(3000);
    const anchor = await blotter.topVisibleRow();

    // The first refresh or two after scrolling settle where the viewport rests; measure from the third on.
    await expect.poll(() => blotter.badgeCount(), { message: 'the badge appears', timeout: 60_000 }).toBeGreaterThan(12);
    const resting = await blotter.restingOffset(anchor.rowId);
    expect(resting).toBeGreaterThanOrEqual(-ROW_HEIGHT);
    // The first background refreshes after scrolling can lose a row or two; the point is that it never runs away.
    expect(resting).toBeLessThan(4 * ROW_HEIGHT);

    // Several background refreshes later (about ten orders) the anchored order has not moved.
    const counted = await blotter.badgeCount();
    await expect.poll(() => blotter.badgeCount(), { message: 'more orders arrive above', timeout: 60_000 }).toBeGreaterThan(counted + 9);
    await expect
      .poll(async () => Math.abs((await blotter.restingOffset(anchor.rowId)) - resting), { message: 'the anchored order stays put' })
      .toBeLessThanOrEqual(2);

    const refreshed = deltas.filter((d) => d.newAbove > 0);
    expect(refreshed.length).toBeGreaterThan(0);
    expect(refreshed.some((d) => d.dirtyRoutes.length > 0)).toBe(true);

    await blotter.badge.click();
    await expect(blotter.badge).toBeHidden();
    await expect(blotter.header('orderId')).toHaveAttribute('aria-sort', 'descending');
  });
});
