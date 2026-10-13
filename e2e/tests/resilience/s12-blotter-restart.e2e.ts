import { expect, test } from '@playwright/test';
import { sleep } from '../../support/harness';
import { plan, printSummary, runScenario, waitUntilElapsed } from '../../support/scenario';
import { readiness, restartService, startBlotterProbe, waitHealthy, type ProbeResult } from '../../support/stack';

/**
 * S12, the blotter restarts: SIGTERM, drain, start, load, warm up. A probe asks it for rows on a fresh socket every
 * 150 ms throughout. It must say not ready before it closes the sockets (live but not ready), it must never serve rows
 * before it says ready, and the open pages must reconnect (close code 1012 means at once) and show the same data as
 * the server and the model afterwards.
 */
test('S12 the blotter restarts: nobody is served before it is ready', async ({ browser }) => {
  const p = plan().s12;
  const probes: ProbeResult[] = [];
  const report = await runScenario(browser, {
    id: 'S12',
    title: `docker compose restart antikythera, ${p.restarts} time(s), probed throughout`,
    rate: 'normal',
    seed: 1012,
    body: async (h) => {
      for (let n = 1; n <= p.restarts; n += 1) {
        await waitUntilElapsed(h, h.elapsed() + p.gapMs);
        h.note('restart antikythera', `#${n}`);
        const probe = startBlotterProbe();
        await restartService('antikythera');
        const up = await waitHealthy('antikythera', 240_000);
        if (!up) throw new Error('antikythera did not come back after the restart');
        await sleep(1500);
        const seen = await probe.stop();
        probes.push(seen);
        h.measure(`probe${n}`, JSON.stringify(seen));
        await h.allConnected(120_000);
        await sleep(5000);
      }
      await sleep(p.gapMs);
    },
    minimums: () => ({ reconnects: p.restarts, deltas: 50 }),
  });
  printSummary(report);
  expect(report.failures).toEqual([]);
  expect(probes).toHaveLength(p.restarts);
  for (const [i, seen] of probes.entries()) {
    expect(seen.servedBeforeReady, `restart ${i + 1}: rows served before ready`).toBe(0);
    // The restart was seen from outside: not ready while alive (draining or loading), and down while it was between processes.
    expect(seen.liveNotReady + seen.down, `restart ${i + 1}: samples while not ready`).toBeGreaterThan(0);
    expect(seen.ready, `restart ${i + 1}: samples once ready`).toBeGreaterThan(0);
    expect(seen.served, `restart ${i + 1}: rows served once ready`).toBeGreaterThan(0);
  }
  expect((await readiness()).ready).toBe(200);
});
