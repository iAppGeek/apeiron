import { mulberry32 } from '@apeiron/logos';
import { expect, test } from '@playwright/test';
import { scrollJump, selectCodec, selectTrader } from '../../support/actions';
import { sleep } from '../../support/harness';
import { pickBetween } from '../../support/plans';
import { plan, printSummary, runScenario } from '../../support/scenario';

/**
 * S2, rapid flapping: a drop every 2 to 5 seconds for two minutes, some timed to land during an in-flight getRows, a
 * hello (the reset toxic fires on the first byte the server sends, which for a fresh connection is the welcome), a
 * trader switch or a codec switch. No view may end up stuck switching or loading, no request promise may be left
 * waiting, and the final state must be the same as the server's.
 */
const KINDS = ['plain', 'getRows', 'hello', 'trader', 'codec', 'down1'] as const;

test('S2 rapid flapping', async ({ browser }) => {
  const p = plan().s2;
  const report = await runScenario(browser, {
    id: 'S2',
    title: `Rapid flapping: drops every 2-5s for ${p.durationMs / 1000}s, including mid-getRows, mid-hello and mid-switch`,
    rate: 'normal',
    seed: 1002,
    body: async (h) => {
      const rng = mulberry32(2002);
      const [v1, , v3] = h.pages;
      if (v1 === undefined || v3 === undefined) throw new Error('S2 needs V1 and V3');
      let traderSwitched = false;
      let codecMsgpack = false;
      let i = 0;
      while (h.elapsed() < p.durationMs) {
        await sleep(pickBetween(rng, 2000, 5000));
        const kind = KINDS[i % KINDS.length] ?? 'plain';
        i += 1;
        h.note(kind);
        let action: Promise<unknown> = Promise.resolve();
        if (kind === 'getRows') action = scrollJump(v1.blotter, i % 2 === 0 ? 4000 : -4000).catch(() => undefined);
        if (kind === 'trader') {
          traderSwitched = !traderSwitched;
          action = selectTrader(v1.page, traderSwitched ? 'Alice Marlowe' : 'All traders').catch(() => undefined);
        }
        if (kind === 'codec') {
          codecMsgpack = !codecMsgpack;
          action = selectCodec(v3.page, codecMsgpack ? 'msgpack' : 'json').catch(() => undefined);
        }
        await sleep(30);
        if (kind === 'hello') {
          await h.faults.down(1000);
          await h.faults.dropClean();
        } else if (kind === 'down1') {
          await h.faults.down(1000);
        } else {
          await h.faults.dropClean();
        }
        await action;
      }
      h.measure('drops', i);
    },
    minimums: () => ({ reconnects: p.minReconnects, deltas: 50 }),
  });
  printSummary(report);
  expect(report.failures).toEqual([]);
});
