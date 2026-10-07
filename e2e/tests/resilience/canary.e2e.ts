import { expect, test } from '@playwright/test';
import { createHarness, sleep } from '../../support/harness';

/**
 * The oracle's own test. A suite that passes proves nothing unless it can fail, so this freezes the connection without
 * closing it (shorter than the client's 6 s heartbeat, so the page does not notice), lets the server move on, and
 * expects check 2 to report the screen as out of date. Then the stall is lifted and the check must pass again.
 */
test('canary: the server-vs-screen check fails on a frozen page and passes once it has caught up', async ({ browser }) => {
  const harness = await createHarness({
    browser,
    scenario: 'canary',
    title: 'Oracle sensitivity: a frozen page must be reported as stale',
    views: ['V1', 'V4'],
    rate: 'normal',
    seed: 1099,
  });
  try {
    await harness.begin();
    await sleep(6000);
    await harness.faults.stall();
    await sleep(4500);
    const frozen = await harness.screens();
    expect(frozen.some((c) => !c.ok), 'a page that stopped receiving data is reported as out of date').toBe(true);

    await harness.faults.clear();
    await harness.allConnected(90_000);
    const report = await harness.end({ reconnects: 1, deltas: 10 });
    expect(report.failures).toEqual([]);
  } finally {
    await harness.teardown();
  }
});
