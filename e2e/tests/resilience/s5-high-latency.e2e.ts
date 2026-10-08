import { expect, test } from '@playwright/test';
import { performDrop } from '../../support/plans';
import { plan, printSummary, runScenario, waitUntilElapsed } from '../../support/scenario';

/**
 * S5, high latency: 300 ms plus or minus 100 ms each way (about 600 ms round trip) for three minutes, with two drops
 * inside it. The grid must converge on the server's state, nothing may go backwards, and the tick-to-screen
 * percentiles (which include the added latency) are recorded in the report.
 */
test('S5 high latency with drops', async ({ browser }) => {
  const p = plan().s5;
  const report = await runScenario(browser, {
    id: 'S5',
    title: `${p.latencyMs}ms +/- 100ms each way for ${p.totalMs / 1000}s, with ${p.dropsAtMs.length} drop(s)`,
    rate: 'normal',
    seed: 1005,
    body: async (h) => {
      await h.faults.latency(p.latencyMs, 100);
      h.note('latency', `${p.latencyMs}ms+-100ms both ways`);
      for (const drop of p.dropsAtMs) {
        await waitUntilElapsed(h, drop.atMs);
        h.note(drop.kind);
        await performDrop(h.faults, drop.kind);
        await h.allConnected(90_000);
      }
      await waitUntilElapsed(h, p.totalMs);
    },
    minimums: () => ({ reconnects: p.dropsAtMs.length, deltas: 50 }),
  });
  printSummary(report);
  expect(report.failures).toEqual([]);
  for (const view of report.views) {
    expect(view.latency.p95MedianMs, `${view.view} tick-to-screen p95 recorded`).not.toBeNull();
  }
});
