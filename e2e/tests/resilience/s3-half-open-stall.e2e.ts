import { expect, test } from '@playwright/test';
import { sleep, until } from '../../support/harness';
import { readStats } from '../../support/pages';
import { SMOKE, printSummary, runScenario } from '../../support/scenario';

/**
 * S3, half-open stall: a timeout toxic with timeout 0 stops all data in both directions and closes nothing, so only
 * the client's own heartbeat can notice. It must treat the socket as dead after 3 ping intervals (6 s, checked every
 * 2 s, so within about 6 to 8 s), reconnect, and end up with correct data. Three stalls of 20 s (smoke: one of 12 s).
 */
const STALLS = SMOKE ? 1 : 3;
const STALL_MS = SMOKE ? 12_000 : 20_000;
/** The heartbeat threshold is 6 s and is checked every 2 s; allow the poll interval and a little scheduling slack. */
const DETECT_MIN_MS = 5000;
const DETECT_MAX_MS = 9500;

test('S3 half-open stall is detected by the client heartbeat @smoke', async ({ browser }) => {
  const detections: number[] = [];
  const report = await runScenario(browser, {
    id: SMOKE ? 'S3-smoke' : 'S3',
    title: `Half-open stall: ${STALLS} x ${STALL_MS / 1000}s with the socket open and no data`,
    rate: 'normal',
    seed: 1003,
    body: async (h) => {
      for (let n = 0; n < STALLS; n += 1) {
        await sleep(8000);
        await h.allConnected(60_000);
        const before = (await h.stats()).map((s) => s.closes);
        const t0 = Date.now();
        await h.faults.stall();
        h.note('stall', `${STALL_MS}ms`);
        const detectedAt = new Map<number, number>();
        await until(
          async () => {
            const now = await Promise.all(h.pages.map((p) => readStats(p.page)));
            now.forEach((s, i) => {
              if (!detectedAt.has(i) && s.closes > (before[i] ?? 0) && (s.lastCloseReason ?? '').startsWith('stale:')) detectedAt.set(i, Date.now() - t0);
            });
            return detectedAt.size === h.pages.length;
          },
          STALL_MS,
          100,
        );
        for (let i = 0; i < h.pages.length; i += 1) detections.push(detectedAt.get(i) ?? -1);
        const left = STALL_MS - (Date.now() - t0);
        if (left > 0) await sleep(left);
        await h.faults.clear();
        await h.allConnected(90_000);
      }
      h.measure('detectMs', detections);
      await sleep(5000);
    },
    minimums: () => ({ reconnects: STALLS, deltas: 20 }),
  });
  printSummary(report);
  expect(report.failures).toEqual([]);
  expect(detections.length).toBe(STALLS * 5);
  for (const ms of detections) {
    expect(ms, 'time to detect the stall').toBeGreaterThanOrEqual(DETECT_MIN_MS);
    expect(ms, 'time to detect the stall').toBeLessThanOrEqual(DETECT_MAX_MS);
  }
});
