import { expect, test } from '@playwright/test';
import { Blotter } from '../support/blotter';
import { isMonotonic, isTextSorted, parseNumber } from '../support/parse';

test.describe('grid', () => {
  test('loads with the row count, the summary and the column headers', async ({ page }) => {
    const blotter = new Blotter(page);
    await blotter.open();

    const total = await blotter.statusRows();
    expect(total).toBeGreaterThanOrEqual(await blotter.minimumRows());

    // The summary strip counts every order by status; the chips add up to the row count.
    await expect
      .poll(async () => {
        const counts = await Promise.all(
          ['LIVE', 'PENDING_START', 'PAUSED', 'FILLED', 'CANCELLED'].map(async (status) =>
            parseNumber((await page.getByTestId(`summary-${status}`).innerText()).replace(status, '')),
          ),
        );
        const sum = counts.reduce((a, b) => a + b, 0);
        return Math.abs(sum - (await blotter.statusRows()));
      })
      .toBeLessThan(50);

    await expect(blotter.header('orderId')).toContainText('Order ID');
    await blotter.revealColumn('createdAt');
    await expect(blotter.header('createdAt')).toHaveAttribute('aria-sort', 'descending');
    expect(await blotter.orderRows.count()).toBeGreaterThan(10);
    await expect(page.getByTestId('status-codec')).toHaveText('json');
  });

  test('sorts numbers and text, ascending and descending', async ({ page }) => {
    const blotter = new Blotter(page);
    await blotter.open();

    await blotter.sort('notionalUsd', 'asc');
    await expect.poll(async () => isMonotonic(await blotter.columnNumbers('notionalUsd'), 'asc')).toBe(true);
    const smallest = (await blotter.columnNumbers('notionalUsd')).filter((n) => !Number.isNaN(n));
    expect(smallest.length).toBeGreaterThan(10);

    await blotter.sort('notionalUsd', 'desc');
    await expect.poll(async () => isMonotonic(await blotter.columnNumbers('notionalUsd'), 'desc')).toBe(true);
    const largest = (await blotter.columnNumbers('notionalUsd')).filter((n) => !Number.isNaN(n));
    expect(largest[0]).toBeGreaterThan(smallest[smallest.length - 1] ?? 0);

    await blotter.sort('traderName', 'asc');
    await expect.poll(async () => isTextSorted(await blotter.columnTexts('traderName'), 'asc')).toBe(true);
  });

  test('clicking a header cycles ascending, descending, then back to unsorted', async ({ page }) => {
    const blotter = new Blotter(page);
    await blotter.open();
    const header = blotter.header('orderId');

    await header.locator('.ag-header-cell-label').click();
    await expect(header).toHaveAttribute('aria-sort', 'ascending');
    await header.locator('.ag-header-cell-label').click();
    await expect(header).toHaveAttribute('aria-sort', 'descending');
    await header.locator('.ag-header-cell-label').click();
    await expect(header).toHaveAttribute('aria-sort', 'none');
    // Sorting by another column replaces the default createdAt sort.
    await blotter.revealColumn('createdAt');
    await expect(blotter.header('createdAt')).toHaveAttribute('aria-sort', 'none');
  });

  test('set filter keeps only the chosen value and shrinks the row count', async ({ page }) => {
    const blotter = new Blotter(page);
    await blotter.open();
    const before = await blotter.statusRows();

    await blotter.filterSet('side', 'BUY');

    await expect.poll(async () => (await blotter.statusRows()) < before, { message: 'the filtered row count' }).toBe(true);
    await blotter.waitUntilSettled();
    await expect.poll(async () => (await blotter.columnTexts('side')).every((t) => t === 'BUY')).toBe(true);
    const after = await blotter.statusRows();
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
    // BUY and SELL split the book roughly evenly.
    expect(after).toBeGreaterThan(before * 0.3);
    expect(after).toBeLessThan(before * 0.7);
  });

  test('number filter: greater than a threshold', async ({ page }) => {
    const blotter = new Blotter(page);
    await blotter.open();
    const before = await blotter.statusRows();
    const threshold = 5_000_000;

    const popup = await blotter.openFilter('notionalUsd');
    await popup.getByRole('combobox', { name: 'Filtering operator' }).click();
    await page.getByRole('option', { name: 'Greater than', exact: true }).click();
    await popup.getByRole('spinbutton', { name: 'Filter Value' }).first().fill(String(threshold));
    await page.keyboard.press('Escape');

    await expect.poll(async () => (await blotter.statusRows()) < before).toBe(true);
    await blotter.waitUntilSettled();
    expect(await blotter.statusRows()).toBeGreaterThan(0);
    await expect.poll(async () => (await blotter.columnNumbers('notionalUsd')).every((n) => n > threshold)).toBe(true);
  });

  test('date filter: equals the value date of the first row', async ({ page }) => {
    const blotter = new Blotter(page);
    await blotter.open();
    const before = await blotter.statusRows();
    const target = (await blotter.columnTexts('valueDate'))[0];
    expect(target).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const popup = await blotter.openFilter('valueDate');
    await popup.getByRole('textbox', { name: 'Filter Value' }).first().fill(target ?? '');
    await page.keyboard.press('Escape');

    await expect.poll(async () => (await blotter.statusRows()) < before).toBe(true);
    await blotter.waitUntilSettled();
    expect(await blotter.statusRows()).toBeGreaterThan(0);
    await expect.poll(async () => (await blotter.columnTexts('valueDate')).every((t) => t === target)).toBe(true);
  });

  test('switching trader narrows the grid to that trader and back again', async ({ page }) => {
    const blotter = new Blotter(page);
    await blotter.open();
    const all = await blotter.statusRows();

    await blotter.chooseTrader('Alice Marlowe');
    await expect(page.getByTestId('trader-select')).toHaveValue('T1');
    await expect.poll(async () => (await blotter.statusRows()) < all).toBe(true);
    await blotter.waitUntilSettled();
    await expect.poll(async () => (await blotter.columnTexts('traderName')).every((t) => t === 'Alice Marlowe')).toBe(true);
    const alice = await blotter.statusRows();
    expect(alice).toBeGreaterThan(0);

    await blotter.chooseTrader('All traders');
    await expect.poll(async () => (await blotter.statusRows()) > alice).toBe(true);
    await expect.poll(async () => new Set(await blotter.columnTexts('traderName')).size).toBeGreaterThan(1);
  });
});
