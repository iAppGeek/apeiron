import { expect, test } from '@playwright/test';
import { readStats } from '../../support/pages';
import { printSummary, runScenario, waitUntilElapsed } from '../../support/scenario';

/**
 * S4, a long outage during a burst: the proxy is down for 60 s while the driver runs at the stress rate (2,000
 * updates and 50 new orders per second). The client must reconnect exactly once, the backlog must clear, and the
 * deep-scrolled view (V2) must come back with its viewport and badge in a sane state.
 */
test('S4 long outage during a stress burst', async ({ browser }) => {
  const measurements: Record<string, unknown> = {};
  const report = await runScenario(browser, {
    id: 'S4',
    title: 'Proxy down for 60s while the driver runs at the stress rate',
    rate: 'stress',
    seed: 1004,
    body: async (h) => {
      const v2 = h.pages.find((p) => p.id === 'V2');
      if (v2 === undefined) throw new Error('S4 needs V2');
      await waitUntilElapsed(h, 10_000);
      const before = await readStats(v2.page);
      const badgeBefore = await v2.blotter.badgeCount();
      h.note('down', '60000ms');
      await h.faults.down(60_000);
      await h.allConnected(90_000);
      await waitUntilElapsed(h, 10_000 + 60_000 + 20_000);
      const after = await readStats(v2.page);
      measurements['v2FirstRowBefore'] = before.firstDisplayedRow;
      measurements['v2FirstRowAfter'] = after.firstDisplayedRow;
      measurements['v2BadgeBefore'] = badgeBefore;
      measurements['v2BadgeAfter'] = await v2.blotter.badgeCount();
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
  // A reload starts over from the top (a known limitation, see docs/TESTING.md): the badge must then be clear, not stuck
  // counting orders above a viewport that is no longer scrolled. If the view did stay deep, it keeps its badge.
  const firstRowAfter = Number(measurements['v2FirstRowAfter']);
  expect(firstRowAfter > 0 || Number(measurements['v2BadgeAfter']) === 0, 'V2 badge after the reload').toBe(true);
});
