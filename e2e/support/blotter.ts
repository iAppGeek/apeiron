import { expect, type Locator, type Page } from '@playwright/test';
import { hasSettled, parseLeadingCount, parseNumber } from './parse';

export type TopRow = { rowId: string; offset: number };

/** One grid row, in pixels. */
export const ROW_HEIGHT = 32;

export type SortDirection = 'asc' | 'desc';

/** The default view: createdAt descending, so a new order lands on top. */
const MIN_ROWS = Number(process.env['E2E_MIN_ROWS'] ?? '100000');

/** A page object for the blotter: AG Grid DOM, header menus and the app's own status widgets. */
export class Blotter {
  constructor(readonly page: Page) {}

  /** Opens the app and waits until the socket is connected and the first rows are on screen. */
  async open(): Promise<void> {
    await this.page.goto('/');
    await this.waitUntilReady();
  }

  async waitUntilReady(): Promise<void> {
    await expect(this.connection).toHaveText('Connected');
    await expect(this.page.getByTestId('blotter-overlay')).toBeHidden();
    await expect(this.rows.first()).toBeVisible();
    await expect.poll(() => this.statusRows(), { message: 'the row count in the status bar' }).toBeGreaterThan(0);
  }

  get connection(): Locator {
    return this.page.getByTestId('status-connection');
  }

  /** Every rendered row, leaf or group. */
  get rows(): Locator {
    return this.page.locator('.ag-row[row-id]');
  }

  get groupRows(): Locator {
    return this.page.locator('.ag-row-group[row-id]');
  }

  /** Rendered leaf rows (orders). */
  get orderRows(): Locator {
    return this.page.locator('.ag-row[row-id]:not(.ag-row-group)');
  }

  rowAt(index: number): Locator {
    return this.page.locator(`.ag-row[row-index="${index}"]`);
  }

  rowById(rowId: string): Locator {
    return this.page.locator(`.ag-row[row-id="${rowId}"]`);
  }

  cell(row: Locator, colId: string): Locator {
    return row.locator(`[col-id="${colId}"]`);
  }

  header(colId: string): Locator {
    return this.page.locator(`.ag-header-cell[col-id="${colId}"]`);
  }

  get badge(): Locator {
    return this.page.getByTestId('new-orders-badge');
  }

  /** The element that scrolls the grid body in both directions (the scrollbar tracks only mirror it). */
  get scroller(): Locator {
    return this.page.locator('.ag-grid-viewport');
  }

  /** The row count the status bar shows: orders in the current view (leaf rows even when grouped). */
  async statusRows(): Promise<number> {
    return parseNumber(await this.page.getByTestId('status-rows').innerText());
  }

  async minimumRows(): Promise<number> {
    return MIN_ROWS;
  }

  async badgeCount(): Promise<number> {
    if (!(await this.badge.isVisible())) return 0;
    return parseLeadingCount(await this.badge.innerText());
  }

  /** The id of the order in the first row (row index 0) of the root route. */
  async firstRowId(): Promise<string | null> {
    return this.rowAt(0).getAttribute('row-id');
  }

  /** Scrolls sideways until the column's header is rendered (columns outside the viewport are not in the DOM). */
  async revealColumn(colId: string): Promise<void> {
    const header = this.header(colId);
    if (await header.count()) return;
    await this.scroller.evaluate((el) => {
      el.scrollLeft = 0;
    });
    for (let step = 0; step < 12; step += 1) {
      if (await header.count()) return;
      await this.scroller.evaluate((el) => {
        el.scrollLeft += 600;
      });
      // Columns render on the next frame after a scroll: wait for this one's header, not for a fixed time.
      await header.waitFor({ state: 'attached', timeout: 500 }).catch(() => undefined);
    }
    await expect(header).toHaveCount(1);
  }

  async scrollLeftEdge(): Promise<void> {
    await this.scroller.evaluate((el) => {
      el.scrollLeft = 0;
    });
  }

  /** The displayed text of one column for every rendered order row, in row order. */
  async columnTexts(colId: string): Promise<string[]> {
    await this.revealColumn(colId);
    return this.page.evaluate((id) => {
      const rows = [...document.querySelectorAll<HTMLElement>('.ag-row[row-id]:not(.ag-row-group)')];
      rows.sort((a, b) => Number(a.getAttribute('row-index')) - Number(b.getAttribute('row-index')));
      return rows.map((row) => row.querySelector(`[col-id="${id}"]`)?.textContent?.trim() ?? '');
    }, colId);
  }

  async columnNumbers(colId: string): Promise<number[]> {
    return (await this.columnTexts(colId)).map(parseNumber);
  }

  /** The first loaded order whose top edge is inside the viewport, and how far below the viewport top it sits. */
  async topVisibleRow(): Promise<TopRow> {
    let found: TopRow | null = null;
    await expect
      .poll(
        async () => {
          found = await this.page.evaluate(() => {
            const viewport = document.querySelector('.ag-body-vertical-scroll-viewport');
            if (viewport === null) return null;
            const top = viewport.getBoundingClientRect().top;
            let best: { rowId: string; offset: number } | null = null;
            for (const row of document.querySelectorAll<HTMLElement>('.ag-row[row-id]:not(.ag-row-group)')) {
              const loaded = /^ALG\d+/.test(row.querySelector('[col-id="orderId"]')?.textContent ?? '');
              const offset = row.getBoundingClientRect().top - top;
              const rowId = row.getAttribute('row-id');
              if (loaded && rowId !== null && offset >= -1 && (best === null || offset < best.offset)) best = { rowId, offset };
            }
            return best;
          });
          return found !== null;
        },
        { message: 'a loaded order at the top of the viewport' },
      )
      .toBe(true);
    if (found === null) throw new Error('no order is visible in the viewport');
    return found;
  }

  /** Where a row's top edge is relative to the viewport top, or null while it is not rendered. */
  async offsetOf(rowId: string): Promise<number | null> {
    return this.page.evaluate((id) => {
      const viewport = document.querySelector('.ag-body-vertical-scroll-viewport');
      const row = [...document.querySelectorAll<HTMLElement>('.ag-row[row-id]')].find((r) => r.getAttribute('row-id') === id);
      if (viewport === null || row === undefined) return null;
      return row.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    }, rowId);
  }

  /**
   * Where an order sits in the viewport once it has stopped moving: three reads 150 ms apart agree. Between background
   * refreshes (once a second) a view that is anchored does not move at all, so this finds the resting position and
   * skips the frame in which new rows have landed and the viewport has not yet been moved back over the order.
   */
  async restingOffset(rowId: string): Promise<number> {
    const reads: number[] = [];
    await expect
      .poll(
        async () => {
          const offset = await this.offsetOf(rowId);
          if (offset === null) reads.length = 0;
          else reads.push(offset);
          return hasSettled(reads, 3, 1);
        },
        { message: `the order ${rowId} to rest in the viewport`, intervals: [150] },
      )
      .toBe(true);
    return reads[reads.length - 1] ?? Number.NaN;
  }

  /** Scrolls the grid body down by a number of rows and waits until orders have loaded and rendered there. */
  async scrollDownRows(rows: number): Promise<void> {
    await this.scroller.evaluate((el, px) => {
      el.scrollTop = px;
    }, rows * ROW_HEIGHT);
    // With more than about a million rows AG Grid scales the scroll height, so the row at a pixel offset is not
    // exactly offset / ROW_HEIGHT. Wait for orders (not placeholders) to render at about that depth.
    await expect
      .poll(
        async () =>
          this.page.evaluate(() => {
            const loaded = [...document.querySelectorAll<HTMLElement>('.ag-row[row-id]')].filter((row) =>
              /^ALG\d+/.test(row.querySelector('[col-id="orderId"]')?.textContent ?? ''),
            );
            return loaded.length === 0 ? 0 : Math.min(...loaded.map((row) => Number(row.getAttribute('row-index'))));
          }),
        { message: `orders rendered about ${rows} rows down` },
      )
      .toBeGreaterThan(rows * 0.9);
  }

  async scrollToTop(): Promise<void> {
    await this.scroller.evaluate((el) => {
      el.scrollTop = 0;
    });
  }

  // --- header menu, sort, filters, grouping -----------------------------------------------------------------

  async openColumnMenu(colId: string): Promise<Locator> {
    await this.revealColumn(colId);
    const header = this.header(colId);
    await header.hover();
    await header.locator('.ag-header-cell-menu-button').click();
    const menu = this.page.locator('.ag-menu').last();
    await expect(menu).toBeVisible();
    return menu;
  }

  async sort(colId: string, direction: SortDirection): Promise<void> {
    const menu = await this.openColumnMenu(colId);
    await menu.getByRole('menuitem', { name: direction === 'asc' ? 'Sort Ascending' : 'Sort Descending' }).click();
    await expect(this.header(colId)).toHaveAttribute('aria-sort', direction === 'asc' ? 'ascending' : 'descending');
    await this.waitUntilSettled();
  }

  async groupBy(colId: string): Promise<void> {
    const menu = await this.openColumnMenu(colId);
    await menu.getByRole('menuitem', { name: /^Group by / }).click();
    await expect(this.groupRows.first()).toBeVisible();
  }

  async openFilter(colId: string): Promise<Locator> {
    await this.revealColumn(colId);
    await this.header(colId).locator('.ag-header-cell-filter-button').click();
    const popup = this.page.locator('.ag-filter-menu').last();
    await expect(popup).toBeVisible();
    return popup;
  }

  /** Narrows a set filter to exactly one value. */
  async filterSet(colId: string, value: string): Promise<void> {
    await this.filterSetValues(colId, [value]);
  }

  /** Narrows a set filter to exactly these values. */
  async filterSetValues(colId: string, values: readonly string[]): Promise<void> {
    const before = await this.statusRows();
    const popup = await this.openFilter(colId);
    await popup.getByRole('option', { name: '(Select All)' }).click();
    for (const value of values) await popup.getByRole('option', { name: value, exact: true }).click();
    await this.page.keyboard.press('Escape');
    await expect.poll(async () => (await this.statusRows()) !== before, { message: 'the filtered row count' }).toBe(true);
    await this.waitUntilSettled();
  }

  /** Narrows the view to one order (a text filter on the order id), so it stays put whatever its status does. */
  async isolate(orderId: string): Promise<void> {
    const popup = await this.openFilter('orderId');
    await popup.getByRole('textbox', { name: 'Filter Value' }).first().fill(orderId);
    await this.page.keyboard.press('Escape');
    await expect(this.rowById(orderId)).toBeVisible();
    await expect.poll(() => this.statusRows(), { message: 'a view of just that order' }).toBe(1);
  }

  /** Waits for the status-bar count to stop changing for a moment (a view change has landed). */
  async waitUntilSettled(): Promise<void> {
    const reads: number[] = [];
    await expect
      .poll(
        async () => {
          reads.push(await this.statusRows());
          return hasSettled(reads, 3, 0);
        },
        { intervals: [150], message: 'the row count to settle' },
      )
      .toBe(true);
  }

  async chooseTrader(name: string): Promise<void> {
    await this.page.getByTestId('trader-select').selectOption({ label: name });
  }

  // --- order commands ---------------------------------------------------------------------------------------

  async openRowMenu(row: Locator, colId = 'status'): Promise<Locator> {
    await this.revealColumn(colId);
    await this.cell(row, colId).click({ button: 'right' });
    const menu = this.page.locator('.ag-menu').first();
    await expect(menu).toBeVisible();
    return menu;
  }

  /** The row ids of rendered order rows whose status cell shows the given status, topmost first. */
  async rowIdsWithStatus(status: string): Promise<string[]> {
    await this.revealColumn('status');
    return this.page.evaluate((wanted) => {
      const rows = [...document.querySelectorAll<HTMLElement>('.ag-row[row-id]:not(.ag-row-group)')];
      rows.sort((a, b) => Number(a.getAttribute('row-index')) - Number(b.getAttribute('row-index')));
      return rows
        .filter((row) => row.querySelector('[col-id="status"]')?.textContent?.trim() === wanted)
        .map((row) => row.getAttribute('row-id') ?? '');
    }, status);
  }

  statusOf(rowId: string): Locator {
    return this.cell(this.rowById(rowId), 'status');
  }
}
