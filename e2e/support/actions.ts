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

/** Right-clicks the status cell of a rendered row and picks an order action from the context menu. */
export async function sendCommand(blotter: Blotter, rowIndex: number, label: OrderCommandLabel): Promise<string> {
  const row = blotter.rowAt(rowIndex);
  const orderId = await row.getAttribute('row-id');
  if (orderId === null) throw new Error(`no row at index ${rowIndex}`);
  const menu = await blotter.openRowMenu(row);
  await menu.getByRole('menuitem', { name: label }).click();
  return orderId;
}
