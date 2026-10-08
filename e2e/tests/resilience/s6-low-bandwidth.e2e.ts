import { expect, test } from '@playwright/test';
import { sleep } from '../../support/harness';
import { fetchCounter } from '../../support/server-probe';
import { plan, printSummary, runScenario, waitUntilElapsed } from '../../support/scenario';

/**
 * S6, low bandwidth: the downstream is limited to 64 KB/s for three minutes, then to 16 KB/s for one minute with the
 * driver switched to the stress rate so the stream outruns the link. The server must conflate under the first limit
 * and cut the client off with SLOW_CONSUMER (close code 1013) under the second; the client must reconnect, purge and
 * end up correct once the bandwidth is back.
 */
test('S6 low bandwidth ends in SLOW_CONSUMER and recovers', async ({ browser }) => {
  const p = plan().s6;
  let conflated = 0;
  let slowConsumers = 0;
  let sawSlowConsumerClose = false;
  const report = await runScenario(browser, {
    id: 'S6',
    title: `Downstream 64KB/s for ${p.phase1Ms / 1000}s, then 16KB/s for ${p.phase2Ms / 1000}s at the stress rate`,
    rate: 'normal',
    seed: 1006,
    body: async (h) => {
      const conflateBefore = await fetchCounter('apeiron_backpressure_events_total', { event: 'soft_conflate' });
      const slowBefore = await fetchCounter('apeiron_backpressure_events_total', { event: 'slow_consumer' });
      await h.faults.bandwidth(64, 'downstream');
      h.note('bandwidth', '64KB/s downstream');
      await waitUntilElapsed(h, p.phase1Ms);
      h.driver.setRate('stress');
      await h.faults.bandwidth(16, 'downstream');
      h.note('bandwidth', '16KB/s downstream, stress rate');
      await waitUntilElapsed(h, p.phase1Ms + p.phase2Ms);
      conflated = (await fetchCounter('apeiron_backpressure_events_total', { event: 'soft_conflate' })) - conflateBefore;
      slowConsumers = (await fetchCounter('apeiron_backpressure_events_total', { event: 'slow_consumer' })) - slowBefore;
      await h.faults.clear();
      h.driver.setRate('normal');
      await h.allConnected(120_000);
      await sleep(1000);
      // The 1013 close frame queues behind the data the server was holding for a throttled link, so a page may only ever
      // see the link go quiet and abandon it (`stale:`). Either is a cut-off the page recovered from.
      sawSlowConsumerClose = (await h.stats()).some((s) => s.closeHistory.some((r) => r === 'code:1013' || r.startsWith('stale:')));
      h.measure('closeReasons', (await h.stats()).flatMap((s) => s.closeHistory).join(' '));
      h.measure('softConflateEvents', conflated);
      h.measure('slowConsumerEvents', slowConsumers);
    },
    // Not every page is cut off (a page with a small view may never fall behind): the test asserts that some page was.
    minimums: () => ({ reconnects: 0, deltas: 100 }),
  });
  printSummary(report);
  expect(report.failures).toEqual([]);
  expect(conflated + slowConsumers, 'the server held back or cut off slow clients').toBeGreaterThan(0);
  expect(slowConsumers, 'SLOW_CONSUMER events at 16KB/s').toBeGreaterThan(0);
  expect(sawSlowConsumerClose, 'a page was cut off (close code 1013, or the link went quiet)').toBe(true);
  expect(Math.max(...report.views.map((v) => v.reconnects)), 'a page reconnected after being cut off').toBeGreaterThan(0);
});
