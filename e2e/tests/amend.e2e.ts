import { expect, test, type Page } from '@playwright/test';
import type { Blotter } from '../support/blotter';
import { openAs, sendRaw, type UserPage } from '../support/users';

/** A LIVE order of Alice's, found in a view of LIVE orders only, and the view narrowed to it. */
async function isolateLiveOrder(alice: UserPage): Promise<string> {
  await alice.blotter.filterSet('status', 'LIVE');
  await expect.poll(async () => (await alice.blotter.rowIdsWithStatus('LIVE')).length, { message: 'a LIVE row on screen' }).toBeGreaterThan(0);
  const [id] = await alice.blotter.rowIdsWithStatus('LIVE');
  if (id === undefined) throw new Error('no LIVE order');
  return id;
}

async function openAmendDialog(blotter: Blotter, page: Page, id: string): Promise<void> {
  const menu = await blotter.openRowMenu(blotter.rowById(id));
  await menu.getByRole('menuitem', { name: 'Amend order…' }).click();
  await expect(page.getByTestId('amend-dialog')).toBeVisible();
}

test.describe('amend', () => {
  test('a changed quantity and limit reach every tab that shows the order; an invalid amend is refused', async ({ browser }) => {
    // A LIVE order can fill at any moment, so the whole sequence is retried with another order.
    await expect(async () => {
      const alice = await openAs(browser, 'TRADER1');
      const id = await isolateLiveOrder(alice);
      const supervisor = await openAs(browser, 'SUPERVISOR');
      await supervisor.blotter.isolate(id);
      await alice.blotter.isolate(id);

      const [before] = await alice.blotter.columnNumbers('orderQty');
      if (before === undefined) throw new Error('no quantity on screen');
      const quantity = before + 1_000;

      await openAmendDialog(alice.blotter, alice.page, id);
      // The dialog warns before sending, in the server's own words.
      await alice.page.getByTestId('amend-qty').fill('0');
      await alice.page.getByTestId('amend-submit').click();
      await expect(alice.page.getByTestId('amend-error')).toContainText('Quantity must be a whole number above the filled quantity');

      await alice.page.getByTestId('amend-qty').fill(String(quantity));
      await alice.page.getByTestId('amend-limit').fill('1.5');
      await alice.page.getByTestId('amend-urgency').selectOption('HIGH');
      await alice.page.getByTestId('amend-submit').click();
      await expect(alice.page.getByTestId('amend-dialog')).toBeHidden();
      await expect(alice.page.getByText(`Amended ${id}`)).toBeVisible({ timeout: 5_000 });

      for (const who of [alice, supervisor]) {
        await expect.poll(() => who.blotter.columnNumbers('orderQty'), { timeout: 5_000, message: 'the new quantity' }).toEqual([quantity]);
        await expect.poll(() => who.blotter.columnNumbers('limitPrice'), { timeout: 5_000, message: 'the new limit price' }).toEqual([1.5]);
        await expect.poll(() => who.blotter.columnTexts('urgency'), { timeout: 5_000, message: 'the new urgency' }).toEqual(['HIGH']);
      }

      // The server refuses what breaks its rules, and what is not the user's to amend.
      await expect(sendRaw(alice.page, 'TRADER1', { t: 'amend', orderId: id, changes: { limitPrice: 1.123456789 } })).resolves.toMatchObject({
        t: 'error',
        code: 'INVALID_AMEND',
      });
      await expect(sendRaw(alice.page, 'TRADER2', { t: 'amend', orderId: id, changes: { urgency: 'LOW' } })).resolves.toMatchObject({
        t: 'error',
        code: 'FORBIDDEN',
      });
    }).toPass({ timeout: 90_000 });
  });

  test('a finished order cannot be amended', async ({ browser }) => {
    const { blotter } = await openAs(browser, 'SUPERVISOR');
    await blotter.filterSet('status', 'FILLED');
    await expect.poll(async () => (await blotter.columnTexts('status')).every((t) => t === 'FILLED')).toBe(true);
    const menu = await blotter.openRowMenu(blotter.rowAt(2));
    await expect(menu.getByRole('menuitem', { name: 'Amend order…' })).toHaveAttribute('aria-disabled', 'true');
  });
});
