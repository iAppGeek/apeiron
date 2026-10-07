import { expect, test, type Page } from '@playwright/test';
import { Blotter } from '../support/blotter';
import { parseNumber } from '../support/parse';

async function openDevMenu(page: Page): Promise<void> {
  const group = page.getByRole('group', { name: 'Developer options' });
  if (!(await group.isVisible())) await page.getByTestId('dev-menu-button').click();
  await expect(group).toBeVisible();
}

test.describe('dev menu', () => {
  test('switches the wire codec to msgpack and back, and live updates keep flowing', async ({ page }) => {
    const blotter = new Blotter(page);
    await blotter.open();
    await expect(page.getByTestId('status-codec')).toHaveText('json');

    const deltasPerSecond = async (): Promise<number> => parseNumber((await page.getByTestId('status-deltas').innerText()).replace('/s', ''));

    await openDevMenu(page);
    await page.getByRole('radio', { name: 'MessagePack' }).click();
    await expect(page.getByTestId('status-codec')).toHaveText('msgpack');
    await expect(page.getByRole('radio', { name: 'MessagePack' })).toBeChecked();
    await expect(blotter.connection).toHaveText('Connected');
    await expect.poll(deltasPerSecond, { message: 'deltas arrive over msgpack', timeout: 30_000 }).toBeGreaterThan(0);
    await expect(blotter.orderRows.first()).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);

    await page.getByRole('radio', { name: 'JSON' }).click();
    await expect(page.getByTestId('status-codec')).toHaveText('json');
    await expect(page.getByRole('radio', { name: 'JSON' })).toBeChecked();
    await expect.poll(deltasPerSecond, { message: 'deltas arrive over json', timeout: 30_000 }).toBeGreaterThan(0);
    await expect(blotter.orderRows.first()).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('the stress preset shows a STRESS pill and Medium takes it away', async ({ page }) => {
    const blotter = new Blotter(page);
    await blotter.open();
    await expect(page.getByTestId('status-preset')).toBeHidden();

    await openDevMenu(page);
    try {
      await page.getByRole('radio', { name: 'Stress' }).click();
      await expect(page.getByTestId('status-preset')).toHaveText('STRESS');
      await expect(blotter.connection).toHaveText('Connected');
    } finally {
      // The preset is global to the stack: always put it back to Medium.
      await openDevMenu(page);
      await page.getByRole('radio', { name: 'Medium' }).click();
    }
    await expect(page.getByTestId('status-preset')).toBeHidden();
  });
});
