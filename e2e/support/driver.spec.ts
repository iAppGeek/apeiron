import { startThemis, type Themis } from '@apeiron/themis/themis';
import { InMemoryOrderRepository, toStoredOrder } from '@apeiron/mnemosyne';
import {
  BUCKETS,
  MemoryBus,
  OVERLAY_FIELDS,
  PAIRS,
  generateOrders,
  parseExecReport,
  type CurrencyPair,
  type ExecReport,
  type Order,
  type OrderCommand,
  type OrderStateRecord,
  type PriceTick,
} from '@apeiron/logos';
import { afterEach, describe, expect, it } from 'vitest';
import { createDriver, type Driver } from './driver';

const SEED_NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const referenceMids = (): Record<CurrencyPair, number> => Object.fromEntries(PAIRS.map((p) => [p.pair, p.mid])) as Record<CurrencyPair, number>;
const silent = { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined };

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

type World = { bus: MemoryBus; repo: InMemoryOrderRepository; themis: Themis; maxId: string | null };

/** The order service running for real on an in-memory bus, holding the open orders; the driver talks to it as it does in the stack. */
async function world(bus: MemoryBus = new MemoryBus()): Promise<World> {
  const repo = new InMemoryOrderRepository();
  await repo.upsertMany(current().map(toStoredOrder));
  const themis = await startThemis({ bus, repo, log: silent, groupCommitMs: 2, groupCommitMax: 200, reconcileWindowMin: 15, rebuildProjection: false });
  return { bus, repo, themis, maxId: await repo.maxOrderId() };
}

type Capture = { reports: ExecReport[]; ticks: PriceTick[]; commands: OrderCommand[] };

async function capture(bus: MemoryBus): Promise<Capture> {
  const out: Capture = { reports: [], ticks: [], commands: [] };
  await bus.subscribe('exec.reports', (p) => {
    const parsed = parseExecReport(p);
    if (parsed.ok) out.reports.push(parsed.value);
  });
  await bus.subscribe('prices.*', (p) => out.ticks.push(p as PriceTick));
  await bus.subscribe('orders.commands', (p) => out.commands.push(p as OrderCommand));
  return out;
}

const OVERLAY = new Set<string>(OVERLAY_FIELDS);

describe('createDriver', () => {
  let driver: Driver | null = null;
  let service: Themis | null = null;
  afterEach(async () => {
    await driver?.dispose();
    await service?.stop();
    driver = null;
    service = null;
  });

  const make = (w: World, extra: Partial<Parameters<typeof createDriver>[0]> = {}): Driver => {
    service = w.themis;
    driver = createDriver({
      bus: w.bus,
      repo: { loadOpen: () => w.repo.loadOpen(), latestMidsByPair: () => Promise.resolve(referenceMids()), maxOrderId: () => w.repo.maxOrderId() },
      seed: 7,
      rate: 'normal',
      stepMs: 10,
      pauseEveryMs: 0,
      ...extra,
    });
    return driver;
  };

  it('feeds its model from the order service: every order the model holds equals the record the service published', async () => {
    const w = await world();
    const seen = await capture(w.bus);
    const d = make(w, { pauseEveryMs: 50, resumeAfterMs: 100 });
    await d.start();
    await wait(1_000);
    await d.stop();
    await w.themis.flush();
    await d.settled(200, 5_000);

    const stats = d.stats();
    expect(stats.publishErrors).toBe(0);
    expect(stats.events).toBeGreaterThan(20);
    expect(stats.ticks).toBeGreaterThan(0);
    expect(seen.reports.length).toBeGreaterThan(20);
    expect(d.startMaxOrderId()).toBe(w.maxId);

    const ids = d.model().idsToVerify();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const record = (await w.bus.kv(BUCKETS.orderState).get(id))?.value as OrderStateRecord;
      const expected = d.model().expected(id)?.order as Order;
      for (const field of Object.keys(record.order) as (keyof Order)[]) {
        // An open order carries the overlay of the last tick on top of its record; every other field is the record's.
        if (OVERLAY.has(field) && (record.order.status === 'LIVE' || record.order.status === 'PAUSED')) continue;
        expect(expected[field], `${id}.${field}`).toEqual(record.order[field]);
      }
    }

    // New orders carry ascending ids above the starting maximum, and the driver counted each once.
    const created = d.model().createdIds;
    expect(created.length).toBeGreaterThan(0);
    expect(created.length).toBe(stats.created);
    expect(created.every((id, i) => id > (created[i - 1] ?? w.maxId ?? ''))).toBe(true);
  });

  it('runs hermes and helios for real: ticks come from the price feed, and reports are numbered per order', async () => {
    const w = await world();
    const seen = await capture(w.bus);
    const d = make(w);
    await d.start();
    await wait(600);
    await d.stop();
    expect(new Set(seen.ticks.map((t) => t.pair)).size).toBe(PAIRS.length);
    const byOrder = new Map<string, number[]>();
    for (const r of seen.reports) byOrder.set(r.orderId, [...(byOrder.get(r.orderId) ?? []), r.execSeq]);
    expect(byOrder.size).toBeGreaterThan(5);
    for (const list of byOrder.values()) expect(list).toEqual([...list].sort((a, b) => a - b));
  });

  it('starts the same way for a seed: the first reports (the startup reconciliation) are identical', async () => {
    const run = async (): Promise<string[]> => {
      const w = await world();
      const seen = await capture(w.bus);
      const d = make(w, { seed: 99 });
      await d.start();
      await d.stop();
      await d.dispose();
      await w.themis.stop();
      service = null;
      driver = null;
      return seen.reports.slice(0, 30).map((r) => `${r.type}:${r.orderId}:${r.execSeq}`);
    };
    const a = await run();
    const b = await run();
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
  });

  it('issues PAUSE commands for LIVE orders and RESUME for the ones it paused', async () => {
    const w = await world();
    const seen = await capture(w.bus);
    const d = make(w, { seed: 3, pauseEveryMs: 20, resumeAfterMs: 40 });
    await d.start();
    await wait(500);
    await d.stop();
    const actions = new Set(seen.commands.map((c) => c.action));
    expect(actions.has('PAUSE')).toBe(true);
    expect(d.stats().commands.pause).toBe(seen.commands.filter((c) => c.action === 'PAUSE').length);
    expect(seen.commands.every((c) => c.requestedBy === 'driver' && c.commandId.startsWith('driver:'))).toBe(true);
  });

  it('retries a report publish that fails once and counts it as a retry, not an error', async () => {
    const bus = new MemoryBus();
    const w = await world(bus);
    let failed = 0;
    const flaky = new Proxy(bus, {
      get(target, prop, receiver): unknown {
        if (prop === 'publish') {
          return (subject: string, payload: unknown): Promise<void> => {
            if (subject === 'exec.reports' && failed < 3) {
              failed += 1;
              return Promise.reject(new Error('timeout'));
            }
            return target.publish(subject, payload);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const d = make({ ...w, bus: flaky }, { seed: 1, retryDelayMs: 1 });
    await d.start();
    await wait(300);
    await d.stop();
    expect(failed).toBe(3);
    expect(d.stats().publishRetries).toBeGreaterThan(0);
    expect(d.stats().publishErrorSamples).toEqual([]);
    expect(d.stats().publishErrors).toBe(0);
  });

  it('counts a report publish that keeps failing, because the model would then be missing a change the bus never got', async () => {
    const bus = new MemoryBus();
    const w = await world(bus);
    const failing = new Proxy(bus, {
      get(target, prop, receiver): unknown {
        if (prop === 'publish') return (subject: string, payload: unknown): Promise<void> => (subject === 'exec.reports' ? Promise.reject(new Error('down')) : target.publish(subject, payload));
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const d = make({ ...w, bus: failing }, { seed: 1, retryDelayMs: 1 });
    await d.start();
    await wait(200);
    await d.stop();
    expect(d.stats().publishErrors).toBeGreaterThan(0);
    expect(d.stats().publishErrorSamples).toEqual(['Error: down']);
  });

  it('settles once the order service has stopped publishing records', async () => {
    const w = await world();
    const d = make(w);
    await d.start();
    await wait(300);
    await d.stop();
    const started = Date.now();
    await d.settled(150, 5_000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
