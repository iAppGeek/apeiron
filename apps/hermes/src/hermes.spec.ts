import {
  BUCKETS,
  MemoryBus,
  parseExecReport,
  parseLoadState,
  priceSubject,
  PAIRS,
  type CurrencyPair,
  type ExecReport,
  type Order,
  type OrderStateRecord,
  type Submission,
  type VenueInstruction,
} from '@apeiron/logos';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_VENUE_TIMEOUT_MS, startHermes, type Hermes } from './hermes.js';
import { createLogger } from './log.js';
import { HermesMetrics } from './metrics.js';
import { SEED_NOW, currentOrders, quotesFor } from './testing.js';

const log = createLogger('error', () => undefined);
let running: Hermes | null = null;

afterEach(async () => {
  await running?.stop();
  running = null;
  vi.useRealTimers();
});

/** What the price feed leaves on the stream: a quote for every pair. */
async function publishQuotes(bus: MemoryBus, ts = SEED_NOW): Promise<void> {
  for (const tick of quotesFor(currentOrders(), ts)) await bus.publish(priceSubject(tick.pair), tick);
}

/** The open orders as the order service holds them (LIVE ones that outlast the test, unless told otherwise). */
const holdingOpen = (): Order[] => currentOrders();
const holdingLive = (): Order[] => currentOrders().filter((o) => o.status === 'LIVE').map((o) => ({ ...o, endTime: SEED_NOW * 2 }));

type Service = { submissions: Submission[]; queries: number };

/** A stand-in for the order service: the open orders it holds, and a submission endpoint that hands out ids. */
async function orderService(bus: MemoryBus, holding: Order[] = holdingOpen()): Promise<Service> {
  const state: Service = { submissions: [], queries: 0 };
  await bus.kv(BUCKETS.orderState).ensure({ history: 1, storage: 'file' });
  let n = 0;
  await bus.serve('orders.submit', (payload) => {
    state.submissions.push(payload as Submission);
    return { ok: true, orderId: `ALG8${String(++n).padStart(7, '0')}`, v: 1 };
  });
  await bus.serve('orders.query.open', async (payload) => {
    state.queries++;
    const { inbox } = payload as { inbox: string };
    const records: OrderStateRecord[] = holding.map((order) => ({ v: 1, execSeq: 0, srcTs: 1, order }));
    await bus.publish(inbox, { chunk: 0, of: 2, records: records.slice(0, 10) });
    await bus.publish(inbox, { chunk: 1, of: 2, records: records.slice(10) });
    return { chunks: 2, count: records.length };
  });
  return state;
}

type StartOptions = { holding?: Order[]; seed?: number; metrics?: HermesMetrics; quotes?: boolean; service?: boolean; priceWaitMs?: number };

async function start(bus: MemoryBus, options: StartOptions = {}): Promise<Hermes> {
  if (options.quotes !== false) await publishQuotes(bus);
  if (options.service !== false) await orderService(bus, options.holding);
  const hermes = await startHermes({
    bus,
    log,
    preset: 'medium',
    seed: options.seed ?? 1,
    stepMs: 100,
    priceWaitMs: options.priceWaitMs ?? 0,
    ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
  });
  running = hermes;
  return hermes;
}

const execReports = (bus: MemoryBus): ExecReport[] =>
  bus.streamLog('EXEC').flatMap((m) => {
    const parsed = parseExecReport(m.payload);
    return parsed.ok ? [parsed.value] : [];
  });

describe('startHermes', () => {
  it('loads the open orders from the order service, reconciles them as execution reports and publishes no prices and no order events', async () => {
    vi.useFakeTimers({ now: SEED_NOW + 2 * 86_400_000 });
    const bus = new MemoryBus();
    const quoteMessages = (await publishQuotes(bus), bus.streamLog('PRICES').length);
    const service = await orderService(bus);
    running = await startHermes({ bus, log, preset: 'medium', seed: 1, stepMs: 100, priceWaitMs: 0 });
    expect(service.queries).toBe(1);
    const stale = currentOrders();
    const reports = execReports(bus);
    expect(reports.length).toBeGreaterThanOrEqual(stale.length);
    expect(new Set(reports.map((r) => r.orderId))).toEqual(new Set(stale.map((o) => o.orderId)));
    const startup = reports.length;

    await vi.advanceTimersByTimeAsync(10_000);
    expect(bus.streamLog('PRICES')).toHaveLength(quoteMessages);
    expect(bus.streamLog('ORDERS').filter((m) => m.subject === 'orders.events')).toEqual([]);
    expect((execReports(bus).length - startup) / 10).toBeGreaterThan(90);
    for (const m of bus.streamLog('EXEC')) expect(m.subject).toBe('exec.reports');
  });

  it('tops LIVE up with submissions, each with its own clientOrderId, and tracks the orders under the ids it is given', async () => {
    vi.useFakeTimers({ now: SEED_NOW + 2 * 86_400_000 });
    const bus = new MemoryBus();
    const service = await orderService(bus);
    await publishQuotes(bus);
    running = await startHermes({ bus, log, preset: 'medium', seed: 1, stepMs: 100, priceWaitMs: 0 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(service.submissions.length).toBeGreaterThan(400);
    expect(new Set(service.submissions.map((s) => s.clientOrderId)).size).toBe(service.submissions.length);
    expect(running.simulator.liveCount).toBeGreaterThanOrEqual(450);
    expect(running.simulator.order('ALG80000001')).toBeDefined();
  });

  it('reports published messages, LIVE count and the preset to its metrics', async () => {
    vi.useFakeTimers({ now: SEED_NOW + 2 * 86_400_000 });
    const metrics = new HermesMetrics();
    const hermes = await start(new MemoryBus(), { metrics });
    await vi.advanceTimersByTimeAsync(3_000);
    const text = await metrics.render();
    const value = (series: string): number => Number(text.split('\n').find((l) => l.startsWith(`${series} `))?.split(' ')[1]);
    expect(value('hermes_events_published_total{type="FILL"}')).toBeGreaterThan(100);
    expect(value('hermes_live_orders')).toBe(hermes.status().live);
    expect(value('hermes_preset{preset="medium"}')).toBe(1);
  });

  it('takes the last quote of every pair from the stream', async () => {
    vi.useFakeTimers({ now: SEED_NOW });
    const hermes = await start(new MemoryBus());
    expect(hermes.quotes.missing()).toEqual([]);
    expect(hermes.quotes.size).toBe(PAIRS.length);
  });

  it('follows live ticks: a newer quote replaces the one it holds, an older one does not', async () => {
    vi.useFakeTimers({ now: SEED_NOW });
    const bus = new MemoryBus();
    const hermes = await start(bus);
    await bus.publish('prices.EURUSD', { pair: 'EURUSD', bid: 2, ask: 2.0002, ts: SEED_NOW + 10 });
    expect(hermes.quotes.mid('EURUSD')).toBeCloseTo(2.0001, 6);
    await bus.publish('prices.EURUSD', { pair: 'EURUSD', bid: 3, ask: 3.0002, ts: SEED_NOW - 5 });
    expect(hermes.quotes.mid('EURUSD')).toBeCloseTo(2.0001, 6);
  });

  it('waits for the feed to publish, and starts without the missing pairs once the wait is over', async () => {
    vi.useFakeTimers({ now: SEED_NOW });
    const bus = new MemoryBus();
    const starting = start(bus, { quotes: false, priceWaitMs: 500 });
    await vi.advanceTimersByTimeAsync(200);
    for (const tick of quotesFor(currentOrders(), SEED_NOW).filter((t) => t.pair !== 'USDTRY' && t.pair !== 'USDZAR')) await bus.publish(priceSubject(tick.pair), tick);
    await vi.advanceTimersByTimeAsync(1_000);
    const hermes = await starting;
    expect(hermes.quotes.missing().sort()).toEqual(['USDTRY', 'USDZAR'] satisfies CurrencyPair[]);
    // A pair with no quote is priced at its reference level.
    expect(hermes.quotes.mid('USDTRY')).toBe(PAIRS.find((p) => p.pair === 'USDTRY')?.mid);
  });

  it('stops following the feed when it stops', async () => {
    vi.useFakeTimers({ now: SEED_NOW });
    const bus = new MemoryBus();
    const hermes = await start(bus);
    await hermes.stop();
    await bus.publish('prices.EURUSD', { pair: 'EURUSD', bid: 9, ask: 9, ts: SEED_NOW + 99 });
    expect(hermes.quotes.mid('EURUSD')).not.toBe(9);
    running = null;
  });

  it('starts from the open orders it was given even when a newer record arrives on the watch, and ignores an older one', async () => {
    vi.useFakeTimers({ now: SEED_NOW });
    const bus = new MemoryBus();
    const orders = holdingLive();
    const hermes = await start(bus, { holding: orders });
    const target = orders[0] as Order;
    await bus.kv(BUCKETS.orderState).put(target.orderId, { v: 5, execSeq: 0, srcTs: 2, order: { ...target, orderQty: 42 } } satisfies OrderStateRecord);
    await vi.advanceTimersByTimeAsync(0);
    expect(hermes.simulator.order(target.orderId)?.orderQty).toBe(42);
    await bus.kv(BUCKETS.orderState).put(target.orderId, { v: 3, execSeq: 0, srcTs: 2, order: { ...target, orderQty: 7 } } satisfies OrderStateRecord);
    await vi.advanceTimersByTimeAsync(0);
    expect(hermes.simulator.order(target.orderId)?.orderQty).toBe(42);
  });

  it('keeps asking until the order service answers the query', async () => {
    vi.useFakeTimers({ now: SEED_NOW });
    const bus = new MemoryBus();
    await publishQuotes(bus);
    const starting = startHermes({ bus, log, preset: 'medium', seed: 1, stepMs: 100, priceWaitMs: 0 });
    await vi.advanceTimersByTimeAsync(2_500);
    const service = await orderService(bus);
    await vi.advanceTimersByTimeAsync(2_500);
    running = await starting;
    expect(service.queries).toBe(1);
  });

  it('stops following the order service when it stops', async () => {
    vi.useFakeTimers({ now: SEED_NOW });
    const bus = new MemoryBus();
    const orders = holdingLive();
    const hermes = await start(bus, { holding: orders });
    await hermes.stop();
    const target = orders[0] as Order;
    await bus.kv(BUCKETS.orderState).put(target.orderId, { v: 9, execSeq: 0, srcTs: 2, order: { ...target, orderQty: 1 } } satisfies OrderStateRecord);
    await vi.advanceTimersByTimeAsync(0);
    expect(hermes.simulator.order(target.orderId)?.orderQty).not.toBe(1);
    running = null;
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
    await vi.advanceTimersByTimeAsync(10);
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
    vi.useFakeTimers({ now: SEED_NOW + 2 * 86_400_000 });
    const bus = new MemoryBus();
    await publishQuotes(bus);
    await orderService(bus);
    const original = bus.publish.bind(bus);
    const publish = vi.spyOn(bus, 'publish').mockImplementation((subject, payload) => (subject === 'exec.reports' ? Promise.reject(new Error('nats down')) : original(subject, payload)));
    const hermes = await start(bus, { quotes: false, service: false });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(publish).toHaveBeenCalled();
    expect(hermes.status().publishErrors).toBeGreaterThan(0);
    expect(hermes.status().eventsPublished).toBe(0);
  });

  it('counts a submission the order service does not answer as a failure, and keeps going', async () => {
    vi.useFakeTimers({ now: SEED_NOW + 2 * 86_400_000 });
    const bus = new MemoryBus();
    await publishQuotes(bus);
    await bus.kv(BUCKETS.orderState).ensure({ history: 1, storage: 'file' });
    await bus.serve('orders.query.open', async (payload) => {
      await bus.publish((payload as { inbox: string }).inbox, { chunk: 0, of: 1, records: [] });
      return { chunks: 1, count: 0 };
    });
    await bus.serve('orders.submit', () => {
      throw new Error('themis down');
    });
    const hermes = await start(bus, { quotes: false, service: false });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(hermes.status().publishErrors).toBeGreaterThan(0);
    expect(hermes.simulator.liveCount).toBe(0);
  });

  it('stops publishing after stop()', async () => {
    vi.useFakeTimers({ now: SEED_NOW + 2 * 86_400_000 });
    const bus = new MemoryBus();
    const hermes = await start(bus);
    await hermes.stop();
    const before = bus.streamLog('EXEC').length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(bus.streamLog('EXEC').length).toBe(before);
    expect(hermes.status().status).toBe('stopped');
    running = null;
  });
});

describe('venue instructions', () => {
  const instruction = (orderId: string, action: VenueInstruction['action'], n: number, ts = SEED_NOW): VenueInstruction => ({ orderId, action, ts, instrId: `c:${n}` });
  const liveOrderId = (): string => holdingLive()[0]?.orderId as string;
  const startWithLive = (bus: MemoryBus): Promise<Hermes> => start(bus, { holding: holdingLive() });
  const reportsFor = (bus: MemoryBus, instrId: string): ExecReport[] => execReports(bus).filter((r) => 'instrId' in r && r.instrId === instrId);

  it('carries out an instruction and reports it, naming the instruction', async () => {
    vi.useFakeTimers({ now: SEED_NOW });
    const bus = new MemoryBus();
    const hermes = await startWithLive(bus);
    const id = liveOrderId();
    await bus.publish('exec.commands', instruction(id, 'PAUSE', 1));
    expect(reportsFor(bus, 'c:1')).toMatchObject([{ type: 'PAUSED', orderId: id }]);
    expect(hermes.simulator.order(id)?.status).toBe('PAUSED');
    expect(hermes.status().commandsHandled).toBe(1);
  });

  it('refuses an invalid transition and an unknown order with a VENUE_REJECT', async () => {
    vi.useFakeTimers({ now: SEED_NOW });
    const bus = new MemoryBus();
    await startWithLive(bus);
    await bus.publish('exec.commands', instruction(liveOrderId(), 'RESUME', 2));
    await bus.publish('exec.commands', instruction('ALG00000001', 'CANCEL', 3));
    expect(reportsFor(bus, 'c:2')[0]).toMatchObject({ type: 'VENUE_REJECT', message: 'Cannot resume an order that is LIVE' });
    expect(reportsFor(bus, 'c:3')[0]).toMatchObject({ type: 'VENUE_REJECT', orderId: 'ALG00000001' });
  });

  it('acknowledges an instruction only after publishing its report', async () => {
    vi.useFakeTimers({ now: SEED_NOW });
    const bus = new MemoryBus();
    const hermes = await startWithLive(bus);
    await bus.publish('exec.commands', instruction(liveOrderId(), 'PAUSE', 4));
    await vi.advanceTimersByTimeAsync(10);
    await hermes.stop();
    running = null;
    const replayed: unknown[] = [];
    await bus.consume({ stream: 'VENUE', durable: 'hermes-venue', subject: 'exec.commands' }, (p) => void replayed.push(p));
    expect(replayed).toEqual([]);
  });

  it('leaves the instruction unacknowledged when the report cannot be published', async () => {
    vi.useFakeTimers({ now: SEED_NOW });
    const bus = new MemoryBus();
    await startWithLive(bus);
    const original = bus.publish.bind(bus);
    vi.spyOn(bus, 'publish').mockImplementation((subject, payload) =>
      subject === 'exec.reports' ? Promise.reject(new Error('nats down')) : original(subject, payload),
    );
    await bus.publish('exec.commands', instruction(liveOrderId(), 'PAUSE', 5));
    await vi.advanceTimersByTimeAsync(10);
    const replayed: unknown[] = [];
    await bus.consume({ stream: 'VENUE', durable: 'hermes-venue', subject: 'exec.commands' }, (p) => void replayed.push(p));
    expect(replayed).toHaveLength(1);
  });

  it('drops invalid instructions, and any older than the order service waits for the venue, without reporting', async () => {
    vi.useFakeTimers({ now: SEED_NOW });
    const bus = new MemoryBus();
    const hermes = await startWithLive(bus);
    const before = hermes.status().commandsHandled;
    await bus.publish('exec.commands', { orderId: 'x', action: 'DELETE' });
    // Just past the order service's 5 s: it has answered TIMEOUT already, so the order must not change.
    await bus.publish('exec.commands', instruction(liveOrderId(), 'PAUSE', 6, SEED_NOW - DEFAULT_VENUE_TIMEOUT_MS - 1));
    expect(reportsFor(bus, 'c:6')).toEqual([]);
    expect(hermes.simulator.order(liveOrderId())?.status).toBe('LIVE');
    expect(hermes.status().commandsHandled).toBe(before);
    // Within the wait, it is carried out.
    await bus.publish('exec.commands', instruction(liveOrderId(), 'PAUSE', 7, SEED_NOW - DEFAULT_VENUE_TIMEOUT_MS + 100));
    expect(reportsFor(bus, 'c:7')).toMatchObject([{ type: 'PAUSED' }]);
  });

  it('follows the configured wait for the venue', async () => {
    vi.useFakeTimers({ now: SEED_NOW });
    const bus = new MemoryBus();
    await publishQuotes(bus);
    await orderService(bus, holdingLive());
    running = await startHermes({ bus, log, preset: 'medium', seed: 1, stepMs: 100, priceWaitMs: 0, venueTimeoutMs: 1_000 });
    await bus.publish('exec.commands', instruction(liveOrderId(), 'PAUSE', 8, SEED_NOW - 1_500));
    expect(reportsFor(bus, 'c:8')).toEqual([]);
  });
});
