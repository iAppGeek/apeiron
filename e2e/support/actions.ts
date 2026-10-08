import { expect, type Page } from '@playwright/test';
import type { Blotter } from './blotter';

/** Scrolls the grid by a few thousand rows, which makes it ask the server for blocks (a `getRows` in flight). */
export async function scrollJump(blotter: Blotter, rows: number): Promise<void> {
  await blotter.scroller.evaluate((el, px) => {
    el.scrollTop += px;
  }, rows * 32);
}

export async function selectTrader(page: Page, name: string): Promise<void> {
  await page.getByTestId('trader-select').selectOption({ label: name });
}

export async function selectCodec(page: Page, codec: 'json' | 'msgpack'): Promise<void> {
  const group = page.getByRole('group', { name: 'Developer options' });
  if (!(await group.isVisible())) await page.getByTestId('dev-menu-button').click();
  await expect(group).toBeVisible();
  await page.getByRole('radio', { name: codec === 'json' ? 'JSON' : 'MessagePack' }).click();
}

export type OrderCommandLabel = 'Pause order' | 'Cancel order' | 'Resume order';

/**
 * Right-clicks the status cell of the `nth` rendered LIVE row and picks an order action from the context menu.
 * Returns the order id it acted on.
 */
export async function sendCommand(blotter: Blotter, nth: number, label: OrderCommandLabel): Promise<string> {
  // A view that was sorted by a far-right column is scrolled sideways; the status cell is only rendered near the left edge.
  await blotter.scrollLeftEdge();
  let ids: string[] = [];
  await expect
    .poll(async () => (ids = await blotter.rowIdsWithStatus('LIVE')).length, { message: `${nth + 1} LIVE rows rendered` })
    .toBeGreaterThan(nth);
  const orderId = ids[nth];
  if (orderId === undefined) throw new Error(`fewer than ${nth + 1} LIVE rows are rendered`);
  const menu = await blotter.openRowMenu(blotter.rowById(orderId));
  await menu.getByRole('menuitem', { name: label }).click();
  // Cancelling is final, so the grid asks first with a one-entry submenu.
  if (label === 'Cancel order') await blotter.page.getByRole('menuitem', { name: `Confirm: cancel ${orderId}` }).click();
  return orderId;
}
