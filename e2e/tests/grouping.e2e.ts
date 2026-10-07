import { expect, test } from '@playwright/test';
import { Blotter } from '../support/blotter';
import { parseGroupCount, parseNumber } from '../support/parse';

const ORDER_ACTIONS = ['Cancel order', 'Pause order', 'Resume order'];

test.describe('grouping', () => {
  test('group by pair, aggregate, and drill down into a group', async ({ page }) => {
    const blotter = new Blotter(page);
    await blotter.open();
    const total = await blotter.statusRows();

    await blotter.groupBy('currencyPair');
    await expect(page.getByTestId('status-groups')).toBeVisible();
    const groups = parseNumber(await page.getByTestId('status-groups').innerText());
    expect(groups).toBeGreaterThan(5);
    // The status bar keeps counting orders (not groups) while grouped.
    expect(Math.abs((await blotter.statusRows()) - total)).toBeLessThan(total * 0.01);

    // Every group shows its key and child count; together the counts cover every order.
    const labels = await blotter.groupRows.locator('.ag-group-value').allInnerTexts();
    expect(labels.length).toBeGreaterThan(5);
    const counts = labels.map((l) => parseGroupCount(l));
    expect(counts.every((c) => c !== null && c > 0)).toBe(true);
    if (labels.length === groups) {
      const sum = counts.reduce<number>((a, c) => a + (c ?? 0), 0);
      expect(Math.abs(sum - (await blotter.statusRows()))).toBeLessThan(total * 0.01);
    }

    // Aggregates: the group row carries a sum of Notional USD, larger than any one of its orders.
    await blotter.revealColumn('notionalUsd');
    const firstGroup = blotter.groupRows.first();
    const aggregate = parseNumber(await blotter.cell(firstGroup, 'notionalUsd').innerText());
    expect(aggregate).toBeGreaterThan(0);

    // Drill down: expanding shows the group's own orders.
    const key = (labels[0] ?? '').replace(/\s*\([\d,]+\)\s*$/, '');
    await firstGroup.locator('.ag-group-contracted').click();
    await expect.poll(() => blotter.orderRows.count(), { message: 'child rows after expanding' }).toBeGreaterThan(0);
    // The grouped Pair column is hidden, so read the pair from its two currencies.
    await expect
      .poll(async () => {
        const base = await blotter.columnTexts('baseCcy');
        const quote = await blotter.columnTexts('quoteCcy');
        return base.length > 0 && base.every((b, i) => `${b}${quote[i] ?? ''}` === key);
      })
      .toBe(true);
    const childNotionals = (await blotter.columnNumbers('notionalUsd')).filter((n) => !Number.isNaN(n));
    expect(childNotionals.length).toBeGreaterThan(0);
    expect(Math.max(...childNotionals)).toBeLessThanOrEqual(aggregate);
  });

  test('group rows offer no order actions; their orders do', async ({ page }) => {
    const blotter = new Blotter(page);
    await blotter.open();
    await blotter.groupBy('status');

    // A group row's menu holds only the copy items.
    const groupMenu = await blotter.openRowMenu(blotter.groupRows.first(), 'ag-Grid-AutoColumn');
    await expect(groupMenu.getByRole('menuitem', { name: /^Copy/ }).first()).toBeVisible();
    for (const name of ORDER_ACTIONS) await expect(groupMenu.getByRole('menuitem', { name })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(groupMenu).toBeHidden();

    // Open a LIVE group: its orders get the actions.
    const live = blotter.groupRows.filter({ hasText: /^LIVE/ });
    await live.locator('.ag-group-contracted').click();
    await expect.poll(() => blotter.orderRows.count()).toBeGreaterThan(0);
    const orderMenu = await blotter.openRowMenu(blotter.orderRows.first(), 'algoType');
    for (const name of ORDER_ACTIONS) await expect(orderMenu.getByRole('menuitem', { name })).toHaveCount(1);
  });
});
