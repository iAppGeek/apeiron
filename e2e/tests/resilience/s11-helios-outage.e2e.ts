import { expect, test } from '@playwright/test';
import { sleep } from '../../support/harness';
import { readStats } from '../../support/pages';
import { plan, printSummary, runScenario, waitUntilElapsed } from '../../support/scenario';

/**
 * S11, the price feed goes quiet: for a while no `prices.*` message is published (as if helios were down) while orders
 * keep filling, being paused and arriving. The blotter must keep serving order changes with the last prices it had, and
 * when the prices resume the overlay must catch up: afterwards the blotter equals the model, which applied exactly the
 * ticks that were published.
 */
test('S11 helios outage: orders still flow, prices resume', async ({ browser }) => {
  const p = plan().s11;
  const measurements: Record<string, number> = {};
  const report = await runScenario(browser, {
    id: 'S11',
    title: `No prices for ${p.outageMs / 1000}s while orders keep flowing`,
    rate: 'normal',
    seed: 1011,
    body: async (h) => {
      const v1 = h.pages.find((page) => page.id === 'V1');
      if (v1 === undefined) throw new Error('S11 needs V1');
      await waitUntilElapsed(h, p.leadMs);
      const before = await readStats(v1.page);
      const eventsBefore = h.driver.stats().events;
      h.note('prices silent', `${p.outageMs}ms`);
      h.driver.pausePrices(true);
      await sleep(p.outageMs);
      const during = await readStats(v1.page);
      const eventsDuring = h.driver.stats().events;
      h.note('prices back');
      h.driver.pausePrices(false);
      measurements['deltasDuringOutage'] = during.deltasApplied - before.deltasApplied;
      measurements['recordsDuringOutage'] = eventsDuring - eventsBefore;
      h.measure('deltasDuringOutage', measurements['deltasDuringOutage']);
      h.measure('recordsDuringOutage', measurements['recordsDuringOutage']);
      await waitUntilElapsed(h, p.leadMs + p.outageMs + p.tailMs);
    },
    minimums: () => ({ reconnects: 0, deltas: 100 }),
  });
  printSummary(report);
  expect(report.failures).toEqual([]);
  // Orders kept flowing with no prices: records reached the model and the page applied deltas for them.
  expect(measurements['recordsDuringOutage'], 'order records during the outage').toBeGreaterThan(20);
  expect(measurements['deltasDuringOutage'], 'deltas the page applied during the outage').toBeGreaterThan(5);
  for (const view of report.views) expect(view.reconnects, `${view.view} reconnects`).toBe(0);
});
