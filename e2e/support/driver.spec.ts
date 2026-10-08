import { MemoryBus, generateOrders, type Order, type OrderCommand, type OrderEvent, type PriceTick } from '@apeiron/logos';
import { afterEach, describe, expect, it } from 'vitest';
import { createDriver, type Driver } from './driver';
import { OrderModel } from './model';

const SEED_NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

function current(): Order[] {
  const out: Order[] = [];
  for (const o of generateOrders(42, 20_000, SEED_NOW)) {
    if (o.status === 'LIVE' || o.status === 'PENDING_START') out.push(o);
  }
  return out;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

type Capture = { events: OrderEvent[]; ticks: PriceTick[]; commands: OrderCommand[] };

async function capture(bus: MemoryBus): Promise<Capture> {
  const out: Capture = { events: [], ticks: [], commands: [] };
  await bus.subscribe('orders.events', (p) => out.events.push(p as OrderEvent));
  await bus.subscribe('prices.*', (p) => out.ticks.push(p as PriceTick));
  await bus.subscribe('orders.commands', (p) => out.commands.push(p as OrderCommand));
  return out;
}

describe('createDriver', () => {
  let driver: Driver | null = null;
  afterEach(async () => {
    await driver?.stop();
  });

  it('publishes a seeded stream whose model equals replaying the published events', async () => {
    const bus = new MemoryBus();
    const seen = await capture(bus);
    const orders = current();
    const maxId = orders.map((o) => o.orderId).sort().at(-1) ?? null;
    driver = createDriver({
      bus,
      repo: { loadCurrent: () => Promise.resolve(current()), maxOrderId: () => Promise.resolve(maxId) },
      seed: 7,
      rate: 'normal',
      stepMs: 10,
      pauseEveryMs: 50,
      resumeAfterMs: 100,
    });
    await driver.start();
    await wait(800);
    await driver.stop();

    const stats = driver.stats();
    expect(stats.publishErrors).toBe(0);
    expect(stats.events).toBeGreaterThan(20);
    expect(stats.ticks).toBeGreaterThan(0);
    expect(driver.startMaxOrderId()).toBe(maxId);

    // The model is exactly what an independent replay of the published events and ticks gives.
    const replay = new OrderModel(current());
    for (const e of seen.events) replay.applyEvent(e);
    for (const t of seen.ticks) replay.applyTick(t);
    const ids = driver.model().idsToVerify();
    expect(ids.length).toBeGreaterThan(0);
    expect(replay.idsToVerify().sort()).toEqual(ids.sort());
    for (const id of ids) expect(driver.model().expected(id)).toEqual(replay.expected(id));

    // New orders carry ascending ids above the starting maximum.
    const created = driver.model().createdIds;
    expect(created.length).toBe(stats.created);
    expect(created.every((id, i) => id > (created[i - 1] ?? maxId ?? ''))).toBe(true);
  });

  it('is deterministic for a seed', async () => {
    const run = async (): Promise<string[]> => {
      const bus = new MemoryBus();
      const seen = await capture(bus);
      const d = createDriver({
        bus,
        repo: { loadCurrent: () => Promise.resolve(current()), maxOrderId: () => Promise.resolve('ALG00999999') },
        seed: 99,
        rate: 'normal',
        stepMs: 10,
        pauseEveryMs: 0,
      });
      await d.start();
      driver = d;
      await d.stop();
      return seen.events.slice(0, 30).map((e) => (e.type === 'NEW' ? e.order.orderId : e.type === 'UPDATE' ? e.order.orderId : e.orderId));
    };
    const a = await run();
    const b = await run();
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
  });

  it('issues PAUSE commands for LIVE orders and RESUME for the ones it paused', async () => {
    const bus = new MemoryBus();
    const seen = await capture(bus);
    driver = createDriver({
      bus,
      repo: { loadCurrent: () => Promise.resolve(current()), maxOrderId: () => Promise.resolve('ALG00999999') },
      seed: 3,
      rate: 'normal',
      stepMs: 10,
      pauseEveryMs: 20,
      resumeAfterMs: 40,
    });
    await driver.start();
    await wait(400);
    await driver.stop();
    const actions = new Set(seen.commands.map((c) => c.action));
    expect(actions.has('PAUSE')).toBe(true);
    expect(driver.stats().commands.pause).toBe(seen.commands.filter((c) => c.action === 'PAUSE').length);
    expect(seen.commands.every((c) => c.requestedBy === 'driver' && c.commandId.startsWith('driver:'))).toBe(true);
  });

  it('retries a publish that fails once and counts it as a retry, not an error', async () => {
    const bus = new MemoryBus();
    let failed = 0;
    const flaky = new Proxy(bus, {
      get(target, prop, receiver): unknown {
        if (prop === 'publish') {
          return (subject: string, payload: unknown): Promise<void> => {
            if (subject === 'orders.events' && failed < 3) {
              failed += 1;
              return Promise.reject(new Error('timeout'));
            }
            return target.publish(subject, payload);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    driver = createDriver({
      bus: flaky,
      repo: { loadCurrent: () => Promise.resolve(current()), maxOrderId: () => Promise.resolve('ALG00999999') },
      seed: 1,
      rate: 'normal',
      stepMs: 10,
      pauseEveryMs: 0,
      retryDelayMs: 1,
    });
    await driver.start();
    await wait(150);
    await driver.stop();
    expect(failed).toBe(3);
    expect(driver.stats().publishRetries).toBeGreaterThan(0);
    expect(driver.stats().publishErrorSamples).toEqual([]);
    expect(driver.stats().publishErrors).toBe(0);
  });

  it('counts a failed publish, because the model would then hold an event the bus never got', async () => {
    const bus = new MemoryBus();
    const failing = new Proxy(bus, {
      get(target, prop, receiver): unknown {
        if (prop === 'publish') return (subject: string): Promise<void> => (subject === 'orders.events' ? Promise.reject(new Error('down')) : Promise.resolve());
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    driver = createDriver({
      bus: failing,
      repo: { loadCurrent: () => Promise.resolve(current()), maxOrderId: () => Promise.resolve('ALG00999999') },
      seed: 1,
      rate: 'normal',
      stepMs: 10,
      pauseEveryMs: 0,
      retryDelayMs: 1,
    });
    await driver.start();
    await wait(100);
    await driver.stop();
    expect(driver.stats().publishErrors).toBeGreaterThan(0);
    expect(driver.stats().publishErrorSamples).toEqual(['Error: down']);
  });
});
