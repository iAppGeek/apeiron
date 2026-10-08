import { expect, test } from '@playwright/test';
import { readStats } from '../../support/pages';
import { plan, printSummary, runScenario, waitUntilElapsed } from '../../support/scenario';

/**
 * S4, a long outage during a burst: the proxy is down for 60 s while the driver runs at the stress rate (2,000
 * updates and 50 new orders per second). The client must reconnect exactly once, the backlog must clear, and the
 * deep-scrolled view (V2) must come back with its viewport and badge in a sane state.
 */
test('S4 long outage during a stress burst', async ({ browser }) => {
  const p = plan().s4;
  const measurements: Record<string, unknown> = {};
  const report = await runScenario(browser, {
    id: 'S4',
    title: `Proxy down for ${p.downMs / 1000}s while the driver runs at the stress rate`,
    rate: 'stress',
    seed: 1004,
    body: async (h) => {
      const v2 = h.pages.find((p) => p.id === 'V2');
      if (v2 === undefined) throw new Error('S4 needs V2');
      await waitUntilElapsed(h, p.leadMs);
      const before = await readStats(v2.page);
      const badgeBefore = await v2.blotter.badgeCount();
      const rowsBefore = await v2.blotter.statusRows();
      h.note('down', `${p.downMs}ms`);
      await h.faults.down(p.downMs);
      await h.allConnected(90_000);
      await waitUntilElapsed(h, p.leadMs + p.downMs + p.tailMs);
      const after = await readStats(v2.page);
      const rowsAfter = await v2.blotter.statusRows();
      measurements['v2Growth'] = rowsAfter - rowsBefore;
      measurements['v2FirstRowBefore'] = before.firstDisplayedRow;
      measurements['v2FirstRowAfter'] = after.firstDisplayedRow;
      measurements['v2BadgeBefore'] = badgeBefore;
      measurements['v2BadgeAfter'] = await v2.blotter.badgeCount();
      h.measure('v2Growth', rowsAfter - rowsBefore);
      h.measure('v2FirstRowBefore', before.firstDisplayedRow ?? -1);
      h.measure('v2FirstRowAfter', after.firstDisplayedRow ?? -1);
      h.measure('v2BadgeBefore', badgeBefore);
      h.measure('v2BadgeAfter', await v2.blotter.badgeCount());
    },
    minimums: () => ({ reconnects: 1, deltas: 100 }),
  });
  printSummary(report);
  expect(report.failures).toEqual([]);
  for (const view of report.views) expect(view.reconnects, `${view.view} reconnects`).toBe(1);
  // The reload keeps the user's place: V2 is back at its old depth, moved down by the orders that arrived above it while
  // the link was down (which is also how many the badge counts), give or take what arrived while it was measured.
  const before = Number(measurements['v2FirstRowBefore']);
  const after = Number(measurements['v2FirstRowAfter']);
  const growth = Number(measurements['v2Growth']);
  expect(before, 'V2 was scrolled deep before the outage').toBeGreaterThan(10_000);
  expect(Math.abs(after - (before + growth)), `V2 first row ${after}, before ${before}, table grew by ${growth}`).toBeLessThanOrEqual(2000);
  expect(Number(measurements['v2BadgeAfter']), 'V2 badge counts the orders that arrived above').toBeGreaterThan(0);
});
