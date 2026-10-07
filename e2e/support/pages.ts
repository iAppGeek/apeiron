import { expect, type Browser, type Page } from '@playwright/test';
import { Blotter } from './blotter';
import type { PageSnapshot } from './oracle';

export const VIEW_IDS = ['V1', 'V2', 'V3', 'V4', 'V5'] as const;
export type ViewId = (typeof VIEW_IDS)[number];

export const VIEW_DESCRIPTIONS: Readonly<Record<ViewId, string>> = {
  V1: 'flat default view, at the top',
  V2: 'flat, scrolled to about row 300,000 (anchoring)',
  V3: 'grouped by status with LIVE drilled open',
  V4: 'status = LIVE sorted by unrealisedPnlUsd desc (the sort key ticks)',
  V5: 'trader T2 only, msgpack',
};

export type ViewPage = { id: ViewId; page: Page; blotter: Blotter };

export const BASE_URL = process.env['RESILIENCE_BASE_URL'] ?? 'http://127.0.0.1:8081';

/** The read-only surface of `window.__apeironTest`, as the tests use it (kept structural so e2e does not import pharos). */
export type PageHooks = {
  loadedRows(): PageSnapshot['rows'];
  groupRows(): PageSnapshot['groups'];
  rootRowCount(): number | null;
  statusBarRowCount(): number | null;
  firstDisplayedRow(): number | null;
  summary(): PageSnapshot['summary'];
  connection(): {
    state: string;
    welcomed: boolean;
    reconnects: number;
    lastCloseReason: string | null;
    closes: number;
    closeHistory: string[];
    pendingRequests: number;
    toastHistory: string[];
  };
  counters(): { deltasApplied: number; rowsUpdated: number; rowsAdded: number; purges: number; lastDeltaAt: number };
  viewState(): PageSnapshot['view'] & { expanded: string[][] };
  latency(): { p50: number | null; p95: number | null };
  lastRequest(): PageSnapshot['request'];
  busy(): boolean;
};

export type PageStats = {
  reconnects: number;
  deltasApplied: number;
  rowsUpdated: number;
  purges: number;
  lastCloseReason: string | null;
  closes: number;
  closeHistory: string[];
  pendingRequests: number;
  toastHistory: string[];
  state: string;
  busy: boolean;
  /** Milliseconds since the last delta was applied, or null if none has been. */
  sinceLastDeltaMs: number | null;
  firstDisplayedRow: number | null;
  latency: { p50: number | null; p95: number | null };
};

/** Reads the counters and connection state from a page. */
export async function readStats(page: Page): Promise<PageStats> {
  return page.evaluate(() => {
    const hooks = (window as unknown as { __apeironTest?: PageHooks }).__apeironTest;
    if (hooks === undefined) throw new Error('window.__apeironTest is missing: is this the VITE_TEST_HOOKS build?');
    const c = hooks.counters();
    const conn = hooks.connection();
    return {
      reconnects: conn.reconnects,
      deltasApplied: c.deltasApplied,
      rowsUpdated: c.rowsUpdated,
      purges: c.purges,
      lastCloseReason: conn.lastCloseReason,
      closes: conn.closes,
      closeHistory: conn.closeHistory,
      pendingRequests: conn.pendingRequests,
      toastHistory: conn.toastHistory,
      state: conn.state,
      busy: hooks.busy(),
      sinceLastDeltaMs: c.lastDeltaAt === 0 ? null : Date.now() - c.lastDeltaAt,
      firstDisplayedRow: hooks.firstDisplayedRow(),
      latency: hooks.latency(),
    };
  });
}

/** Everything check 2 needs from a page, in one evaluation so it is one consistent moment. */
export async function readSnapshot(page: Page): Promise<PageSnapshot> {
  return page.evaluate(() => {
    const hooks = (window as unknown as { __apeironTest?: PageHooks }).__apeironTest;
    if (hooks === undefined) throw new Error('window.__apeironTest is missing');
    return {
      rows: hooks.loadedRows(),
      groups: hooks.groupRows(),
      rootRowCount: hooks.rootRowCount(),
      statusBarRowCount: hooks.statusBarRowCount(),
      summary: hooks.summary(),
      view: hooks.viewState(),
      request: hooks.lastRequest(),
      busy: hooks.busy(),
    };
  });
}

async function selectMsgpack(page: Page): Promise<void> {
  const group = page.getByRole('group', { name: 'Developer options' });
  if (!(await group.isVisible())) await page.getByTestId('dev-menu-button').click();
  await expect(group).toBeVisible();
  await page.getByRole('radio', { name: 'MessagePack' }).click();
  await expect(page.getByTestId('status-codec')).toHaveText('msgpack');
  await page.getByTestId('dev-menu-button').click();
}

/** Opens one of the five views from Appendix G in its own browser context. */
export async function openView(browser: Browser, id: ViewId): Promise<ViewPage> {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  const blotter = new Blotter(page);
  await blotter.open();
  switch (id) {
    case 'V1':
      break;
    case 'V2':
      // About row 300,000 of the 1M-row dataset; on a smaller one (CI seeds 200k) the same relative depth.
      await blotter.scrollDownRows(Math.min(300_000, Math.floor((await blotter.statusRows()) * 0.3)));
      break;
    case 'V3': {
      await blotter.groupBy('status');
      const live = blotter.groupRows.filter({ hasText: /^LIVE/ });
      await live.locator('.ag-group-contracted').click();
      await expect.poll(() => blotter.orderRows.count(), { message: 'the LIVE group to open' }).toBeGreaterThan(0);
      break;
    }
    case 'V4':
      await blotter.filterSet('status', 'LIVE');
      await blotter.sort('unrealisedPnlUsd', 'desc');
      break;
    case 'V5':
      await blotter.chooseTrader('Ben Okafor');
      await expect(page.getByTestId('trader-select')).toHaveValue('T2');
      await blotter.waitUntilSettled();
      await selectMsgpack(page);
      await blotter.waitUntilSettled();
      break;
  }
  await page.waitForFunction(() => (window as unknown as { __apeironTest?: unknown }).__apeironTest !== undefined);
  return { id, page, blotter };
}
