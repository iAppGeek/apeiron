import { expect, test, type Browser, type Page } from '@playwright/test';
import { Blotter } from '../support/blotter';

async function openAs(browser: Browser, user: string): Promise<{ page: Page; blotter: Blotter }> {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  const blotter = new Blotter(page);
  await blotter.open(user);
  return { page, blotter };
}

/** Says hello as `userId` on a raw socket from the page, sends one command and returns the first error or ack. */
async function forgeCommand(page: Page, userId: string, orderId: string): Promise<{ t: string; code?: string }> {
  return page.evaluate(
    ({ userId: user, orderId: order }) =>
      new Promise<{ t: string; code?: string }>((resolve, reject) => {
        const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
        const timer = setTimeout(() => reject(new Error('no answer to the forged command')), 10_000);
        socket.onopen = (): void => {
          socket.send(JSON.stringify({ t: 'hello', userId: user, traderId: 'ALL', codec: 'json', clientId: `forge-${Math.random()}` }));
        };
        socket.onmessage = (event): void => {
          const msg = JSON.parse(String(event.data)) as { t: string; code?: string };
          if (msg.t === 'welcome') socket.send(JSON.stringify({ t: 'command', reqId: 1, orderId: order, action: 'CANCEL' }));
          else if (msg.t === 'error' || msg.t === 'ack') {
            clearTimeout(timer);
            socket.close();
            resolve(msg);
          }
        };
      }),
    { userId, orderId },
  );
}

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
    await expect(forgeCommand(alice.page, 'TRADER1', benOrder)).resolves.toMatchObject({ t: 'error', code: 'FORBIDDEN' });
    await expect(forgeCommand(alice.page, 'NOBODY', benOrder)).resolves.toMatchObject({ t: 'error', code: 'UNKNOWN_USER' });
  });

  test('switching user in the header reloads the grid for the new user', async ({ browser }) => {
    const { page, blotter } = await openAs(browser, 'TRADER1');
    await page.getByTestId('user-select').selectOption('TRADER3');
    await expect(page.getByTestId('trader-select').locator('option')).toHaveText(['All traders', 'Chloe Tanaka']);
    await expect.poll(async () => [...new Set(await blotter.columnTexts('traderId'))]).toEqual(['T3']);
  });
});
