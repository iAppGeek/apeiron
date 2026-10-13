import { expect, test } from '@playwright/test';
import { sleep } from '../../support/harness';
import { plan, printSummary, runScenario, waitUntilElapsed } from '../../support/scenario';
import { restartService, waitHealthy } from '../../support/stack';

/**
 * S10, the order service restarts mid-stream: `docker compose restart themis`, while the driver keeps sending
 * execution reports (they wait in the EXEC stream) and new orders (refused while the service is down). The durable
 * consumer replays what was not acknowledged and the service recovers its state, so afterwards every order's stored
 * record must equal what replaying the venue's reports gives (no lost fill, none applied twice: `venue-vs-service`), the
 * blotter must equal the model (`model-vs-server`), and the pages, which only see records, need not reconnect.
 */
test('S10 themis restarts mid-stream', async ({ browser }) => {
  const p = plan().s10;
  const report = await runScenario(browser, {
    id: 'S10',
    title: `docker compose restart themis, ${p.restarts} time(s), while reports and orders flow`,
    rate: 'normal',
    seed: 1010,
    body: async (h) => {
      for (let n = 1; n <= p.restarts; n += 1) {
        await waitUntilElapsed(h, h.elapsed() + p.gapMs);
        h.note('restart themis', `#${n}`);
        await restartService('themis');
        const up = await waitHealthy('themis', 180_000);
        if (!up) throw new Error('themis did not come back after the restart');
        await h.allConnected(60_000);
        await sleep(5000);
      }
      await sleep(p.gapMs);
    },
    // The pages only see records, so a restart behind them needs no reconnect; what must flow is the stream itself.
    minimums: () => ({ reconnects: 0, deltas: 50 }),
  });
  printSummary(report);
  expect(report.failures).toEqual([]);
  expect(report.checks.map((c) => c.name)).toContain('venue-vs-service');
  expect(report.driver.publishErrors).toBe(0);
});
