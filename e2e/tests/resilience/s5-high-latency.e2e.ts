import { expect, test } from '@playwright/test';
import { printSummary, runScenario, waitUntilElapsed } from '../../support/scenario';

/**
 * S5, high latency: 300 ms plus or minus 100 ms each way (about 600 ms round trip) for three minutes, with two drops
 * inside it. The grid must converge on the server's state, nothing may go backwards, and the tick-to-screen
 * percentiles (which include the added latency) are recorded in the report.
 */
test('S5 high latency with drops', async ({ browser }) => {
  const report = await runScenario(browser, {
    id: 'S5',
    title: '300ms +/- 100ms each way for 3 minutes, with 2 drops',
    rate: 'normal',
    seed: 1005,
    body: async (h) => {
      await h.faults.latency(300, 100);
      h.note('latency', '300ms+-100ms both ways');
      await waitUntilElapsed(h, 60_000);
      h.note('clean');
      await h.faults.dropClean();
      await h.allConnected(90_000);
      await waitUntilElapsed(h, 120_000);
      h.note('down3');
      await h.faults.down(3000);
      await h.allConnected(90_000);
      await waitUntilElapsed(h, 180_000);
    },
    minimums: () => ({ reconnects: 2, deltas: 100 }),
  });
  printSummary(report);
  expect(report.failures).toEqual([]);
  for (const view of report.views) {
    expect(view.latency.p95MedianMs, `${view.view} tick-to-screen p95 recorded`).not.toBeNull();
  }
});
