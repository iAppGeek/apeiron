import { MemoryBus, PAIRS, type CurrencyPair } from '@apeiron/logos';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from './log.js';
import { startLevels } from './start-levels.js';

const log = createLogger('error', () => undefined);
const nosleep = (): Promise<void> => Promise.resolve();
const reference = (pair: CurrencyPair): number => PAIRS.find((p) => p.pair === pair)?.mid as number;

describe('startLevels', () => {
  it('uses the last price of each pair, as the middle of bid and ask', async () => {
    const bus = new MemoryBus();
    await bus.publish('prices.EURUSD', { pair: 'EURUSD', bid: 1.0, ask: 1.0, ts: 1 });
    await bus.publish('prices.EURUSD', { pair: 'EURUSD', bid: 1.2, ask: 1.4, ts: 2 });
    const refs = vi.fn(() => Object.fromEntries(PAIRS.map((p) => [p.pair, 5])));
    await bus.serve('ref.mids', refs);
    const { levels, sources } = await startLevels(bus, log, { sleep: nosleep });
    expect(levels.EURUSD).toBeCloseTo(1.3, 10);
    expect(sources.EURUSD).toBe('last-price');
    // The other pairs have no price, so the order service's levels fill them in.
    expect(levels.GBPUSD).toBe(5);
    expect(sources.GBPUSD).toBe('ref-mids');
  });

  it('does not ask the order service when every pair has a last price', async () => {
    const bus = new MemoryBus();
    for (const p of PAIRS) await bus.publish(`prices.${p.pair}`, { pair: p.pair, bid: p.mid, ask: p.mid, ts: 1 });
    const request = vi.spyOn(bus, 'request');
    const { sources } = await startLevels(bus, log);
    expect(request).not.toHaveBeenCalled();
    expect(Object.values(sources).every((s) => s === 'last-price')).toBe(true);
  });

  it('retries the request until the order service answers', async () => {
    const bus = new MemoryBus();
    let t = 0;
    const sleep = vi.fn(async () => {
      t += 500;
      if (t === 1_500) await bus.serve('ref.mids', () => Object.fromEntries(PAIRS.map((p) => [p.pair, 2])));
    });
    const { levels } = await startLevels(bus, log, { now: () => t, sleep, refMidsWaitMs: 10_000 });
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(levels.USDJPY).toBe(2);
  });

  it('falls back to the reference levels after the wait', async () => {
    const bus = new MemoryBus();
    let t = 0;
    const sleep = vi.fn(async () => {
      t += 1_000;
    });
    const { levels, sources } = await startLevels(bus, log, { now: () => t, sleep, refMidsWaitMs: 3_000 });
    expect(levels.EURUSD).toBe(reference('EURUSD'));
    expect(Object.values(sources).every((s) => s === 'reference')).toBe(true);
    expect(sleep.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('ignores unusable replies and unreadable prices', async () => {
    const bus = new MemoryBus();
    await bus.publish('prices.EURUSD', { nonsense: true });
    await bus.serve('ref.mids', () => ({ EURUSD: -1, GBPUSD: 'x' }));
    const { levels, sources } = await startLevels(bus, log, { sleep: nosleep });
    expect(levels.EURUSD).toBe(reference('EURUSD'));
    expect(sources.EURUSD).toBe('reference');
  });
});
