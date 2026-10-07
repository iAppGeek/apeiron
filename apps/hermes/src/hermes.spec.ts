import { MemoryBus, parseOrderEvent, parsePriceTick, PAIRS, type OrderEvent, type PriceTick } from '@apeiron/logos';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startHermes, type Hermes } from './hermes.js';
import { createLogger } from './log.js';
import { SEED_NOW, currentOrders } from './testing.js';

const log = createLogger('error', () => undefined);
let running: Hermes | null = null;

afterEach(async () => {
  await running?.stop();
  running = null;
  vi.useRealTimers();
});

async function start(bus: MemoryBus, overrides: { maxOrderId?: string | null; seed?: number } = {}): Promise<Hermes> {
  const hermes = await startHermes({
    bus,
    log,
    preset: 'medium',
    current: currentOrders(),
    maxOrderId: overrides.maxOrderId ?? 'ALG00100000',
    seed: overrides.seed ?? 1,
    stepMs: 100,
  });
  running = hermes;
  return hermes;
}

describe('startHermes', () => {
  it('reconciles at startup, then publishes prices at 3 ticks/s per pair and events at the preset rate', async () => {
    vi.useFakeTimers({ now: SEED_NOW + 2 * 86_400_000 });
    const bus = new MemoryBus();
    const ticks: PriceTick[] = [];
    await bus.subscribe('prices.*', (p) => {
      const parsed = parsePriceTick(p);
      if (parsed.ok) ticks.push(parsed.value);
    });
    await start(bus);
    const startupEvents = bus.streamLog('ORDERS').length;
    expect(startupEvents).toBeGreaterThan(0);
    expect(ticks).toHaveLength(PAIRS.length);

    ticks.length = 0;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ticks.length / PAIRS.length / 10).toBeGreaterThan(2.5);
    expect(ticks.length / PAIRS.length / 10).toBeLessThan(3.5);
    const events = bus.streamLog('ORDERS').slice(startupEvents);
    expect(events.length / 10).toBeGreaterThan(90);
    for (const m of events) {
      expect(m.subject).toBe('orders.events');
      expect(parseOrderEvent(m.payload).ok).toBe(true);
    }
  });

  it('continues order ids above maxOrderId', async () => {
    vi.useFakeTimers({ now: SEED_NOW });
    const bus = new MemoryBus();
    await start(bus, { maxOrderId: 'ALG09999990' });
    await vi.advanceTimersByTimeAsync(2_000);
    const ids = bus
      .streamLog('ORDERS')
      .map((m) => m.payload as OrderEvent)
      .filter((e): e is Extract<OrderEvent, { type: 'NEW' }> => e.type === 'NEW')
      .map((e) => e.order.orderId);
    expect(ids[0]).toBe('ALG09999991');
    expect(ids).toEqual([...ids].sort());
  });

  it('switches presets on control.load and ignores invalid messages', async () => {
    vi.useFakeTimers({ now: SEED_NOW });
    const bus = new MemoryBus();
    const hermes = await start(bus);
    expect(hermes.status().preset).toBe('medium');
    await bus.publish('control.load', { preset: 'bogus' });
    expect(hermes.status().preset).toBe('medium');
    await bus.publish('control.load', { preset: 'stress' });
    expect(hermes.status().preset).toBe('stress');
    expect(hermes.simulator.liveCount).toBe(3_000);
  });

  it('counts publish failures without crashing', async () => {
    vi.useFakeTimers({ now: SEED_NOW });
    const bus = new MemoryBus();
    const publish = vi.spyOn(bus, 'publish').mockRejectedValue(new Error('nats down'));
    const hermes = await start(bus);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(publish).toHaveBeenCalled();
    expect(hermes.status().publishErrors).toBeGreaterThan(0);
    expect(hermes.status().eventsPublished).toBe(0);
  });

  it('stops publishing after stop()', async () => {
    vi.useFakeTimers({ now: SEED_NOW });
    const bus = new MemoryBus();
    const hermes = await start(bus);
    await hermes.stop();
    const before = bus.streamLog('ORDERS').length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(bus.streamLog('ORDERS').length).toBe(before);
    expect(hermes.status().status).toBe('stopped');
    running = null;
  });
});
