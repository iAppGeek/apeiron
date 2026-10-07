import { MemoryBus, makeCommandId, parseLoadState, parseOrderEvent, parsePriceTick, PAIRS, type OrderCommand, type OrderEvent, type PriceTick } from '@apeiron/logos';
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

  it('publishes control.state at startup, on every change and every 5 seconds', async () => {
    vi.useFakeTimers({ now: SEED_NOW });
    const bus = new MemoryBus();
    const seen: string[] = [];
    await bus.subscribe('control.state', (p) => {
      const parsed = parseLoadState(p);
      if (parsed.ok) seen.push(parsed.value.preset);
    });
    await start(bus);
    expect(seen).toEqual(['medium']);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(seen).toEqual(['medium', 'medium']);
    await bus.publish('control.load', { preset: 'stress' });
    expect(seen).toEqual(['medium', 'medium', 'stress']);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(seen.at(-1)).toBe('stress');
    expect(seen).toHaveLength(4);
  });

  it('does not publish control.state after stop()', async () => {
    vi.useFakeTimers({ now: SEED_NOW });
    const bus = new MemoryBus();
    const seen: unknown[] = [];
    await bus.subscribe('control.state', (p) => void seen.push(p));
    const hermes = await start(bus);
    await hermes.stop();
    seen.length = 0;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(seen).toEqual([]);
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

describe('order commands', () => {
  const eventsFor = (bus: MemoryBus, commandId: string): OrderEvent[] =>
    bus
      .streamLog('ORDERS')
      .filter((m) => m.subject === 'orders.events')
      .map((m) => m.payload as OrderEvent)
      .filter((e) => 'commandId' in e && e.commandId === commandId);

  const cmd = (orderId: string, action: OrderCommand['action'], reqId: number, ts = SEED_NOW): OrderCommand => ({
    orderId,
    action,
    requestedBy: 'client-1',
    ts,
    commandId: makeCommandId('client-1', reqId),
  });

  const liveOrderId = (): string => currentOrders().find((o) => o.status === 'LIVE')?.orderId as string;

  it('answers a valid command with an UPDATE carrying the command id and absolute values', async () => {
    vi.useFakeTimers({ now: SEED_NOW });
    const bus = new MemoryBus();
    const hermes = await start(bus);
    const id = liveOrderId();
    await bus.publish('orders.commands', cmd(id, 'PAUSE', 1));
    const [event] = eventsFor(bus, 'client-1:1');
    expect(event).toMatchObject({ type: 'UPDATE', order: { orderId: id, status: 'PAUSED' } });
    expect(hermes.simulator.order(id)?.status).toBe('PAUSED');
    expect(hermes.status().commandsHandled).toBe(1);
  });

  it('answers an invalid transition and an unknown order with REJECT', async () => {
    vi.useFakeTimers({ now: SEED_NOW });
    const bus = new MemoryBus();
    await start(bus);
    await bus.publish('orders.commands', cmd(liveOrderId(), 'RESUME', 2));
    await bus.publish('orders.commands', cmd('ALG00000001', 'CANCEL', 3));
    expect(eventsFor(bus, 'client-1:2')[0]).toMatchObject({ type: 'REJECT', code: 'INVALID_TRANSITION' });
    expect(eventsFor(bus, 'client-1:3')[0]).toMatchObject({ type: 'REJECT', code: 'UNKNOWN_ORDER' });
  });

  it('acknowledges a command only after publishing its answer', async () => {
    vi.useFakeTimers({ now: SEED_NOW });
    const bus = new MemoryBus();
    const hermes = await start(bus);
    await bus.publish('orders.commands', cmd(liveOrderId(), 'PAUSE', 4));
    await vi.advanceTimersByTimeAsync(10);
    await hermes.stop();
    running = null;
    const replayed: unknown[] = [];
    await bus.consume({ stream: 'ORDERS', durable: 'hermes-commands', subject: 'orders.commands' }, (p) => void replayed.push(p));
    expect(replayed).toEqual([]);
  });

  it('leaves the command unacknowledged when the answer cannot be published', async () => {
    vi.useFakeTimers({ now: SEED_NOW });
    const bus = new MemoryBus();
    await start(bus);
    const original = bus.publish.bind(bus);
    vi.spyOn(bus, 'publish').mockImplementation((subject, payload) =>
      subject === 'orders.events' ? Promise.reject(new Error('nats down')) : original(subject, payload),
    );
    await bus.publish('orders.commands', cmd(liveOrderId(), 'PAUSE', 5));
    await vi.advanceTimersByTimeAsync(10);
    const replayed: unknown[] = [];
    await bus.consume({ stream: 'ORDERS', durable: 'hermes-commands', subject: 'orders.commands' }, (p) => void replayed.push(p));
    expect(replayed).toHaveLength(1);
  });

  it('drops invalid and stale commands without answering', async () => {
    vi.useFakeTimers({ now: SEED_NOW });
    const bus = new MemoryBus();
    const hermes = await start(bus);
    const before = hermes.status().commandsHandled;
    await bus.publish('orders.commands', { orderId: 'x', action: 'DELETE' });
    await bus.publish('orders.commands', cmd(liveOrderId(), 'PAUSE', 6, SEED_NOW - 31_000));
    expect(eventsFor(bus, 'client-1:6')).toEqual([]);
    expect(hermes.status().commandsHandled).toBe(before);
  });
});
