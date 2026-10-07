import {
  SUBJECTS,
  CONSUMERS,
  STREAMS,
  parseOrderEvent,
  parsePriceTick,
  type Bus,
  type BusSubscription,
  type LoadPreset,
} from '@apeiron/logos';
import type { OrderRepository } from '@apeiron/mnemosyne';
import type { QueryEngine } from '../query/engine.js';
import type { View, ViewChanges } from '../query/view.js';
import type { LiveHooks, ClientSession } from '../session.js';
import type { ColumnarStore } from '../store/columnar-store.js';
import { DEFAULT_BACKPRESSURE, type BackpressureOptions } from './backpressure.js';
import type { StatusSummary } from './counters.js';
import { LiveStore } from './live-store.js';
import { SystemStats } from './system-stats.js';
import { WriteBehind } from './write-behind.js';

export type RuntimeLogger = {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
};

export type LiveRuntimeOptions = {
  store: ColumnarStore;
  engine: QueryEngine;
  repo: OrderRepository;
  bus: Bus;
  log: RuntimeLogger;
  flushMs: number;
  writeBehindMs: number;
  maxTrackedBlocks: number;
  backpressure?: BackpressureOptions;
  summaryIntervalMs?: number;
  /** How often to look for string ranks that need catching up (default 30s: at most one refresh per interval). */
  rankRefreshMs?: number;
  /** Views idle this long with no subscribers are dropped (default 60s). */
  viewIdleMs?: number;
  /** Wait between attempts to attach to the streams (hermes creates them, so they may not exist yet). */
  retryMs?: number;
};

export type FlushStats = {
  flushes: number;
  lastMs: number;
  maxMs: number;
  totalMs: number;
  lastChanges: number;
  totalChanges: number;
  lastViews: number;
};

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * The live half of the server. After the store has loaded it attaches to the bus (the durable `blotter-server`
 * consumer on `orders.events`, `prices.*`), then every `flushMs` it applies the queued events and ticks to the
 * store, patches every cached view from the tick's ChangeSet, and lets each client session send its delta. It
 * also runs write-behind, keeps string ranks fresh in the background and drops idle views.
 */
export class LiveRuntime implements LiveHooks {
  readonly live: LiveStore;
  readonly system = new SystemStats();
  readonly writeBehind: WriteBehind;
  readonly flushStats: FlushStats = { flushes: 0, lastMs: 0, maxMs: 0, totalMs: 0, lastChanges: 0, totalChanges: 0, lastViews: 0 };
  readonly maxTrackedBlocks: number;
  readonly backpressure: BackpressureOptions;
  readonly summaryIntervalMs: number;
  private readonly sessions = new Set<ClientSession>();
  private readonly subscriptions: BusSubscription[] = [];
  private timers: ReturnType<typeof setInterval>[] = [];
  private flushing = false;
  private refreshing = false;
  private attachTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private attached = false;

  constructor(private readonly options: LiveRuntimeOptions) {
    this.live = new LiveStore(options.store, options.log);
    this.writeBehind = new WriteBehind(this.live, options.repo, options.log, options.writeBehindMs);
    this.maxTrackedBlocks = options.maxTrackedBlocks;
    this.backpressure = options.backpressure ?? DEFAULT_BACKPRESSURE;
    this.summaryIntervalMs = options.summaryIntervalMs ?? 1_000;
  }

  /** True once the bus subscriptions are in place. */
  get isAttached(): boolean {
    return this.attached;
  }

  get clientCount(): number {
    return this.sessions.size;
  }

  /** Builds the live indexes from the loaded store, starts the loops, and attaches to the bus (retrying until the streams exist). */
  start(): void {
    this.live.init();
    this.system.start();
    this.system.sample();
    this.timers.push(setInterval(() => this.flush(), this.options.flushMs));
    this.timers.push(setInterval(() => this.system.sample(), 1_000));
    this.timers.push(setInterval(() => void this.refreshRanks(), this.options.rankRefreshMs ?? 30_000));
    this.timers.push(setInterval(() => this.options.engine.sweep(this.options.viewIdleMs ?? 60_000), 10_000));
    this.writeBehind.start();
    void this.attach();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.attachTimer !== null) clearTimeout(this.attachTimer);
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const sub of this.subscriptions) await sub.close().catch(() => undefined);
    this.subscriptions.length = 0;
    this.flush();
    await this.writeBehind.stop();
    this.system.stop();
  }

  // ---- LiveHooks (what sessions use)

  register(session: ClientSession): void {
    this.sessions.add(session);
  }

  unregister(session: ClientSession): void {
    this.sessions.delete(session);
  }

  setPreset(preset: LoadPreset): Promise<void> {
    return this.options.bus.publish(SUBJECTS.controlLoad, { preset });
  }

  summary(traderId: string): StatusSummary {
    return this.live.counters.scoped(traderId);
  }

  stats(): { cpu: number; rssMb: number; elLagMs: number } {
    return this.system.latest;
  }

  // ---- flush

  /** One tick: apply queued events and ticks, patch the views, let every client send. Never overlaps itself. */
  flush(): void {
    if (this.flushing) return;
    this.flushing = true;
    const t0 = performance.now();
    try {
      const now = Date.now();
      const cs = this.live.flush(now);
      const changes: ViewChanges[] = cs.size > 0 ? this.options.engine.applyChanges(cs) : [];
      const byView = new Map<View, ViewChanges>(changes.map((c): [View, ViewChanges] => [c.view, c]));
      for (const session of [...this.sessions]) {
        try {
          session.onFlush({ cs, byView, now, store: this.options.store });
        } catch (error) {
          this.options.log.error({ err: error }, 'session flush failed');
        }
      }
      const ms = performance.now() - t0;
      const s = this.flushStats;
      s.flushes++;
      s.lastMs = ms;
      s.maxMs = Math.max(s.maxMs, ms);
      s.totalMs += ms;
      s.lastChanges = cs.size;
      s.totalChanges += cs.size;
      s.lastViews = changes.length;
    } catch (error) {
      this.options.log.error({ err: error }, 'flush failed');
    } finally {
      this.flushing = false;
    }
  }

  // ---- string ranks

  /** Brings stale string ranks up to date in slices (at most once per interval; each slice is short). */
  async refreshRanks(): Promise<void> {
    if (this.refreshing || this.stopped) return;
    this.refreshing = true;
    try {
      for (const field of this.options.store.staleRankFields()) {
        for (const _ of this.options.store.refreshStringRanks(field)) {
          void _;
          await yieldToLoop();
        }
      }
    } finally {
      this.refreshing = false;
    }
  }

  // ---- bus

  private async attach(): Promise<void> {
    if (this.stopped) return;
    const { bus, log } = this.options;
    try {
      const prices = await bus.subscribe(SUBJECTS.pricesWildcard, (payload) => {
        const parsed = parsePriceTick(payload);
        if (parsed.ok) this.live.enqueueTick(parsed.value);
      });
      this.subscriptions.push(prices);
      const orders = await bus.consume(
        { stream: STREAMS.orders, durable: CONSUMERS.blotterServer, subject: SUBJECTS.ordersEvents },
        (payload, _subject, ack) => {
          const parsed = parseOrderEvent(payload);
          if (!parsed.ok) {
            log.warn({ error: parsed.error }, 'dropped invalid order event');
            ack();
            return;
          }
          this.live.enqueueEvent(parsed.value, ack);
        },
      );
      this.subscriptions.push(orders);
      this.attached = true;
      log.info({ stream: STREAMS.orders, durable: CONSUMERS.blotterServer }, 'attached to the message bus');
    } catch (error) {
      for (const sub of this.subscriptions.splice(0)) await sub.close().catch(() => undefined);
      log.warn({ err: error }, 'could not attach to the message bus yet, retrying');
      this.attachTimer = setTimeout(() => void this.attach(), this.options.retryMs ?? 2_000);
    }
  }
}
