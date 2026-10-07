import { expect, test, type Page } from '@playwright/test';
import { Blotter } from '../support/blotter';
import { parseNumber } from '../support/parse';

const ACTIONS = ['Cancel order', 'Pause order', 'Resume order'];

/** The id of a LIVE order, found in a view of LIVE orders only (what is on top depends on what the stack has been doing). */
async function findLiveOrder(blotter: Blotter): Promise<string> {
  await blotter.filterSet('status', 'LIVE');
  await expect.poll(async () => (await blotter.rowIdsWithStatus('LIVE')).length, { message: 'a LIVE row on screen' }).toBeGreaterThan(0);
  const [id] = await blotter.rowIdsWithStatus('LIVE');
  if (id === undefined) throw new Error('no LIVE order');
  return id;
}

/**
 * Opens a fresh blotter showing one LIVE order and nothing else, so it stays in view as its status changes. A LIVE
 * order can fill at any moment, so the callers retry the whole sequence with another order.
 */
async function openOnLiveOrder(page: Page): Promise<{ blotter: Blotter; id: string }> {
  const picker = new Blotter(page);
  await picker.open();
  const id = await findLiveOrder(picker);
  const blotter = new Blotter(page);
  await blotter.open();
  await blotter.isolate(id);
  return { blotter, id };
}

test.describe('order actions', () => {
  test('Pause and Resume round trip', async ({ page }) => {
    await expect(async () => {
      const { blotter, id } = await openOnLiveOrder(page);
      await expect(blotter.statusOf(id)).toHaveText('LIVE');

      const menu = await blotter.openRowMenu(blotter.rowById(id));
      await expect(menu.getByRole('menuitem', { name: 'Resume order' })).toHaveAttribute('aria-disabled', 'true');
      await menu.getByRole('menuitem', { name: 'Pause order' }).click();
      await expect(blotter.statusOf(id)).toHaveText('PAUSED', { timeout: 5_000 });

      const resumeMenu = await blotter.openRowMenu(blotter.rowById(id));
      await expect(resumeMenu.getByRole('menuitem', { name: 'Pause order' })).toHaveAttribute('aria-disabled', 'true');
      await resumeMenu.getByRole('menuitem', { name: 'Resume order' }).click();
      await expect(blotter.statusOf(id)).toHaveText('LIVE', { timeout: 5_000 });
    }).toPass({ timeout: 60_000 });
  });

  test('Cancel asks for confirmation and then cancels', async ({ page }) => {
    let cancelledBefore = 0;
    await expect(async () => {
      const { blotter, id } = await openOnLiveOrder(page);
      cancelledBefore = parseNumber((await page.getByTestId('summary-CANCELLED').innerText()).replace('CANCELLED', ''));

      // Backing out of the confirmation changes nothing.
      const menu = await blotter.openRowMenu(blotter.rowById(id));
      await menu.getByRole('menuitem', { name: 'Cancel order' }).click();
      await expect(page.getByRole('menuitem', { name: `Confirm: cancel ${id}` })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menuitem', { name: 'Cancel order' })).toBeHidden();
      await expect(blotter.statusOf(id)).not.toHaveText('CANCELLED');

      // Confirming sends the command.
      const again = await blotter.openRowMenu(blotter.rowById(id));
      await again.getByRole('menuitem', { name: 'Cancel order' }).click();
      await page.getByRole('menuitem', { name: `Confirm: cancel ${id}` }).click();
      await expect(blotter.statusOf(id)).toHaveText('CANCELLED', { timeout: 5_000 });

      // A cancelled order is final: every action is disabled.
      const finalMenu = await blotter.openRowMenu(blotter.rowById(id));
      for (const name of ACTIONS) await expect(finalMenu.getByRole('menuitem', { name })).toHaveAttribute('aria-disabled', 'true');
      await page.keyboard.press('Escape');
    }).toPass({ timeout: 60_000 });

    await expect
      .poll(async () => parseNumber((await page.getByTestId('summary-CANCELLED').innerText()).replace('CANCELLED', '')))
      .toBeGreaterThan(cancelledBefore);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('a finished order offers no actions', async ({ page }) => {
    const blotter = new Blotter(page);
    await blotter.open();
    await blotter.filterSet('status', 'FILLED');
    await expect.poll(async () => (await blotter.columnTexts('status')).every((t) => t === 'FILLED')).toBe(true);

    const menu = await blotter.openRowMenu(blotter.rowAt(2));
    for (const name of ACTIONS) await expect(menu.getByRole('menuitem', { name })).toHaveAttribute('aria-disabled', 'true');
    await expect(menu.getByRole('menuitem', { name: /^Copy/ }).first()).toBeVisible();
  });
});
