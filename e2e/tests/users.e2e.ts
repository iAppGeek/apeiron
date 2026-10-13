import { expect, test } from '@playwright/test';
import { openAs, sendRaw } from '../support/users';

test.describe('users and entitlements', () => {
  test('each trader sees only their own orders, a forged command is refused, and the supervisor sees all', async ({ browser }) => {
    const alice = await openAs(browser, 'TRADER1');
    const ben = await openAs(browser, 'TRADER2');
    const supervisor = await openAs(browser, 'SUPERVISOR');

    for (const [who, trader] of [[alice, 'T1'], [ben, 'T2']] as const) {
      const traders = await who.blotter.columnTexts('traderId');
      expect(traders.length).toBeGreaterThan(0);
      expect(new Set(traders)).toEqual(new Set([trader]));
    }
    await expect(alice.page.getByTestId('trader-select').locator('option')).toHaveText(['All traders', 'Alice Marlowe']);
    await expect(supervisor.page.getByTestId('trader-select').locator('option')).toHaveCount(6);
    await expect(alice.page.getByTestId('user-select')).toHaveValue('TRADER1');

    const aliceRows = await alice.blotter.statusRows();
    const benRows = await ben.blotter.statusRows();
    const allRows = await supervisor.blotter.statusRows();
    expect(aliceRows).toBeGreaterThan(0);
    expect(benRows).toBeGreaterThan(0);
    expect(allRows).toBeGreaterThan(aliceRows + benRows);

    // Ben's newest order, named by Alice's page over her own socket: refused before it reaches the order service.
    const benOrder = await ben.blotter.firstRowId();
    if (benOrder === null) throw new Error('Ben has no order on screen');
    await expect(sendRaw(alice.page, 'TRADER1', { t: 'command', orderId: benOrder, action: 'CANCEL' })).resolves.toMatchObject({ t: 'error', code: 'FORBIDDEN' });
    await expect(sendRaw(alice.page, 'NOBODY', { t: 'command', orderId: benOrder, action: 'CANCEL' })).resolves.toMatchObject({ t: 'error', code: 'UNKNOWN_USER' });
  });

  test('switching user in the header reloads the grid for the new user', async ({ browser }) => {
    const { page, blotter } = await openAs(browser, 'TRADER1');
    await page.getByTestId('user-select').selectOption('TRADER3');
    await expect(page.getByTestId('trader-select').locator('option')).toHaveText(['All traders', 'Chloe Tanaka']);
    await expect.poll(async () => [...new Set(await blotter.columnTexts('traderId'))]).toEqual(['T3']);
  });
});
