import { expect, test } from '@playwright/test';
import { DOWN_MS, SMOKE_DOWN_MS, dropSchedule, performDrop } from '../../support/plans';
import { TIER, plan, printSummary, runScenario, waitUntilElapsed } from '../../support/scenario';

/**
 * S1, the required scenario: the initial image, then updates for minutes, with the WebSocket dropped on a schedule
 * (rotating clean reset / proxy down 3 s / proxy down 10 s). Full: 10 drops 30 s apart. Quick: 6 drops 20 s apart.
 * Smoke: 5 drops 10 s apart with shorter outages.
 */
test('S1 steady updates with periodic drops @smoke', async ({ browser }) => {
  const p = plan().s1;
  const report = await runScenario(browser, {
    id: 'S1',
    title: `Steady updates, ${p.drops} drops ${p.intervalMs / 1000}s apart (${TIER})`,
    rate: 'normal',
    seed: 1001,
    body: async (h) => {
      for (const drop of dropSchedule(p.drops, p.intervalMs, p.firstAtMs)) {
        await waitUntilElapsed(h, drop.atMs);
        // A drop only counts as one when it lands on an established connection.
        await h.allConnected(60_000);
        h.note(drop.kind);
        await performDrop(h.faults, drop.kind, p.shortOutages ? SMOKE_DOWN_MS : DOWN_MS);
      }
      await waitUntilElapsed(h, p.firstAtMs + p.drops * p.intervalMs);
    },
    minimums: () => ({ reconnects: p.drops, deltas: 20 }),
  });
  printSummary(report);
  expect(report.failures).toEqual([]);
});
