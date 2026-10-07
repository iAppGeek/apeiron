import { expect, test } from '@playwright/test';
import { DOWN_MS, SMOKE_DOWN_MS, dropSchedule, performDrop } from '../../support/plans';
import { SMOKE, printSummary, runScenario, waitUntilElapsed } from '../../support/scenario';

/**
 * S1, the required scenario: the initial image, then updates for about five minutes, with the WebSocket dropped every
 * 30 seconds (ten drops, rotating clean reset / proxy down 3 s / proxy down 10 s). Smoke variant: 60 s, every 10 s.
 */
const DROPS = SMOKE ? 5 : 10;
const INTERVAL_MS = SMOKE ? 10_000 : 30_000;
const FIRST_MS = SMOKE ? 8000 : 20_000;

test('S1 steady updates with a drop every 30s @smoke', async ({ browser }) => {
  const report = await runScenario(browser, {
    id: SMOKE ? 'S1-smoke' : 'S1',
    title: `Steady updates, ${DROPS} drops ${INTERVAL_MS / 1000}s apart`,
    rate: 'normal',
    seed: 1001,
    body: async (h) => {
      for (const drop of dropSchedule(DROPS, INTERVAL_MS, FIRST_MS)) {
        await waitUntilElapsed(h, drop.atMs);
        // A drop only counts as one when it lands on an established connection.
        await h.allConnected(60_000);
        h.note(drop.kind);
        await performDrop(h.faults, drop.kind, SMOKE ? SMOKE_DOWN_MS : DOWN_MS);
      }
      await waitUntilElapsed(h, FIRST_MS + DROPS * INTERVAL_MS);
    },
    minimums: () => ({ reconnects: DROPS, deltas: 20 }),
  });
  printSummary(report);
  expect(report.failures).toEqual([]);
});
