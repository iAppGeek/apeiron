import { expect, test } from '@playwright/test';
import { sleep } from '../../support/harness';
import { sendCommand } from '../../support/actions';
import { printSummary, runScenario, waitUntilElapsed } from '../../support/scenario';

/**
 * S8, a command across a drop: Pause and Cancel are sent from the grid, then the connection is dropped before the
 * ack can arrive (a downstream delay holds it back). The client must show an error or time out and never hang, with
 * no spinner left on the row and no request left waiting; the final grid must equal the server whether or not the
 * command was applied.
 */
const ROUNDS = [
  { label: 'Pause order', downMs: 1000 },
  { label: 'Cancel order', downMs: 3000 },
  { label: 'Pause order', downMs: 1000 },
  { label: 'Cancel order', downMs: 3000 },
] as const;

test('S8 commands sent just before a drop', async ({ browser }) => {
  const sent: string[] = [];
  const report = await runScenario(browser, {
    id: 'S8',
    title: 'Pause and Cancel sent, then the connection dropped before the ack',
    rate: 'normal',
    seed: 1008,
    body: async (h) => {
      const v4 = h.pages.find((p) => p.id === 'V4');
      if (v4 === undefined) throw new Error('S8 needs V4');
      for (const [i, round] of ROUNDS.entries()) {
        await waitUntilElapsed(h, 15_000 * (i + 1));
        await h.allConnected(60_000);
        await h.faults.latency(1500, 0);
        const orderId = await sendCommand(v4.blotter, 3 + i, round.label);
        sent.push(`${round.label} ${orderId}`);
        h.note(`command ${round.label}`, orderId);
        await sleep(150);
        // The proxy goes down while the ack is still held back, so the request can never be answered on this connection.
        // The client must say so rather than wait: an error toast appears while the link is down.
        const dropped = h.faults.down(round.downMs);
        await expect(v4.page.getByRole('alert').first()).toBeVisible({ timeout: 15_000 });
        await dropped;
        await h.faults.clear();
        await h.allConnected(60_000);
      }
      await waitUntilElapsed(h, 15_000 * (ROUNDS.length + 1));
      // Nothing waits for an ack that can no longer come.
      for (const p of h.pages) await expect(p.page.getByTestId('command-pending')).toHaveCount(0);
    },
    minimums: () => ({ reconnects: ROUNDS.length, deltas: 20 }),
  });
  printSummary(report);
  expect(report.failures).toEqual([]);
  expect(sent).toHaveLength(ROUNDS.length);
});
