import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { sleep, until } from '../../support/harness';
import { printSummary, runScenario, waitUntilElapsed } from '../../support/scenario';

const run = promisify(execFile);
const root = new URL('../../../', import.meta.url).pathname;

async function serverHealthy(): Promise<boolean> {
  const response = await fetch('http://127.0.0.1:4000/health').catch(() => null);
  return response !== null && response.ok;
}

/**
 * S7, server restart: `docker compose restart antikythera` in the middle of the stream, twice. The server reloads
 * its store from the database and the durable consumer replays what was not acknowledged, so the model check passing
 * afterwards proves no event was lost on the server side; the clients must reconnect and purge.
 */
test('S7 antikythera restarts twice mid-stream', async ({ browser }) => {
  const report = await runScenario(browser, {
    id: 'S7',
    title: 'docker compose restart antikythera, twice, while updates flow',
    rate: 'normal',
    seed: 1007,
    body: async (h) => {
      for (let n = 1; n <= 2; n += 1) {
        await waitUntilElapsed(h, n === 1 ? 25_000 : h.elapsed() + 25_000);
        h.note('restart antikythera', `#${n}`);
        await run('docker', ['compose', '--profile', 'core', 'restart', 'antikythera'], { cwd: root });
        const up = await until(serverHealthy, 180_000, 1000);
        if (!up) throw new Error('antikythera did not come back after the restart');
        await h.allConnected(120_000);
        await sleep(2000);
      }
      await sleep(25_000);
    },
    minimums: () => ({ reconnects: 2, deltas: 100 }),
  });
  printSummary(report);
  expect(report.failures).toEqual([]);
});
