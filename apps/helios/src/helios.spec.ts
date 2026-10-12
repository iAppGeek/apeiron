import { MemoryBus, PAIRS, parsePriceTick, type PriceTick } from '@apeiron/logos';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startHelios, type Helios } from './helios.js';
import { createLogger } from './log.js';
import { HeliosMetrics } from './metrics.js';
import { referenceMids } from './price-feed.js';

const log = createLogger('error', () => undefined);
let running: Helios | null = null;

afterEach(async () => {
  await running?.stop();
  running = null;
  vi.useRealTimers();
});

async function collect(bus: MemoryBus): Promise<PriceTick[]> {
  const ticks: PriceTick[] = [];
  await bus.subscribe('prices.*', (p) => {
    const parsed = parsePriceTick(p);
    if (parsed.ok) ticks.push(parsed.value);
  });
  return ticks;
}

describe('startHelios', () => {
  it('publishes one tick per pair at once, then 3 ticks per second per pair', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const bus = new MemoryBus();
    const ticks = await collect(bus);
    running = startHelios({ bus, log, levels: referenceMids(), seed: 1 });
    expect(ticks).toHaveLength(PAIRS.length);
    ticks.length = 0;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ticks.length / PAIRS.length / 10).toBeGreaterThan(2.8);
    expect(ticks.length / PAIRS.length / 10).toBeLessThan(3.2);
  });

  it('starts each walk at the given level', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const bus = new MemoryBus();
    const ticks = await collect(bus);
    running = startHelios({ bus, log, levels: { ...referenceMids(), EURUSD: 1.5 }, seed: 1 });
    const eur = ticks.find((t) => t.pair === 'EURUSD');
    expect((((eur?.bid ?? 0) + (eur?.ask ?? 0)) / 2)).toBeCloseTo(1.5, 2);
  });

  it('stores the last price of every pair on the stream, for whoever starts later', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const bus = new MemoryBus();
    running = startHelios({ bus, log, levels: referenceMids(), seed: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await bus.lastPerSubject('PRICES', 'prices.*')).toHaveLength(PAIRS.length);
  });

  it('is deterministic for a seed', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const run = async (seed: number): Promise<PriceTick[]> => {
      const bus = new MemoryBus();
      const ticks = await collect(bus);
      const h = startHelios({ bus, log, levels: referenceMids(), seed });
      await vi.advanceTimersByTimeAsync(2_000);
      await h.stop();
      return ticks.map(({ ts: _ts, ...rest }) => rest as PriceTick);
    };
    expect(await run(3)).toEqual(await run(3));
    expect(await run(3)).not.toEqual(await run(4));
  });

  it('counts ticks and failed publishes, and reports its status', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const bus = new MemoryBus();
    const metrics = new HeliosMetrics();
    const publish = vi.spyOn(bus, 'publish');
    publish.mockRejectedValueOnce(new Error('nats down'));
    running = startHelios({ bus, log, levels: referenceMids(), seed: 1, metrics });
    await vi.advanceTimersByTimeAsync(0);
    expect(running.status()).toMatchObject({ status: 'ok', publishErrors: 1, ticksPublished: PAIRS.length - 1 });
    const text = await metrics.render();
    expect(text).toContain('helios_publish_errors_total 1');
    await running.stop();
    expect(running.status().status).toBe('stopped');
    const before = running.status().ticksPublished;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(running.status().ticksPublished).toBe(before);
  });

  it('keeps its tick times on the clock it is given', async () => {
    let t = 5_000;
    const bus = new MemoryBus();
    const ticks = await collect(bus);
    vi.useFakeTimers();
    running = startHelios({ bus, log, levels: referenceMids(), seed: 1, now: () => t });
    t = 6_000;
    await vi.advanceTimersByTimeAsync(60);
    expect(new Set(ticks.map((x) => x.ts))).toEqual(new Set([5_000, 6_000]));
  });
});
