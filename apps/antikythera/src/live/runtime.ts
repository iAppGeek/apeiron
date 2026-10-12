import {
  CURRENCY_PAIRS,
  STREAMS,
  SUBJECTS,
  canApplyCommand,
  makeCommandId,
  parseLoadState,
  parseOrderEvent,
  parsePriceTick,
  type Bus,
  type BusSubscription,
  type KvEntry,
  type KvWatch,
  type OrderCommand,
  type OrderEvent,
  type OrderStatus,
  type LoadPreset,
} from '@apeiron/logos';
import { readRecord } from '../records.js';
import type { RuntimeMetrics } from '../metrics.js';
import type { QueryEngine } from '../query/engine.js';
import type { View, ViewChanges } from '../query/view.js';
import type { LiveHooks, ClientSession, CommandRequest } from '../session.js';
import type { ColumnarStore } from '../store/columnar-store.js';
import { CommandCorrelator, type CommandOutcome } from './commands.js';
import { DEFAULT_BACKPRESSURE, type BackpressureOptions } from './backpressure.js';
import type { StatusSummary } from './counters.js';
import { LiveStore } from './live-store.js';
import { SystemStats } from './system-stats.js';

/** Where the blotter is in starting up. The snapshot is loaded before the runtime exists. */
export type Stage = 'snapshot' | 'catchup' | 'prices' | 'ready';

/** What the snapshot hands over: the still-open watch, and the highest revision it saw. */
export type WatchHandoff = { entries: AsyncIterator<KvEntry>; watch: KvWatch; revision: number };

export type RuntimeLogger = {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
};

export type LiveRuntimeOptions = {
  store: ColumnarStore;
  engine: QueryEngine;
  bus: Bus;
  log: RuntimeLogger;
  flushMs: number;
  maxTrackedBlocks: number;
  backpressure?: BackpressureOptions;
  summaryIntervalMs?: number;
  /** How often to look for string ranks that need catching up (default 30s: at most one refresh per interval). */
  rankRefreshMs?: number;
  /** Views idle this long with no subscribers are dropped (default 60s). */
  viewIdleMs?: number;
  /** How long a command may wait for hermes before the client gets an error (default 5s). */
  commandTimeoutMs?: number;
  /** Wait between attempts to attach to the bus. */
  retryMs?: number;
  /** The order-state watch to continue from. Without one the runtime applies no records (tests that only feed ticks). */
  snapshot?: WatchHandoff;
  /** Most time to wait at startup for a price for every pair (default 10 s); missing pairs are logged. */
  priceWaitMs?: number;
  /** Caught up once a watch entry has at most this many entries pending behind it (default 100). */
  catchupMaxPending?: number;
  /** Called when the stage changes. */
  onStage?: (stage: Stage, seconds: number) => void;
  /** Called when the order-state watch ends unexpectedly: the process cannot keep its store current. */
  onFatal?: (reason: string) => void;
  metrics?: RuntimeMetrics;
  /** Most time one flush may spend patching views before the rest wait for the next tick (default 40 ms). */
  flushBudgetMs?: number;
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
 * keeps string ranks fresh in the background and drops idle views.
 */
export class LiveRuntime implements LiveHooks {
  readonly live: LiveStore;
  readonly system = new SystemStats();
  readonly flushStats: FlushStats = { flushes: 0, lastMs: 0, maxMs: 0, totalMs: 0, lastChanges: 0, totalChanges: 0, lastViews: 0 };
  readonly maxTrackedBlocks: number;
  readonly backpressure: BackpressureOptions;
  readonly summaryIntervalMs: number;
  readonly commands: CommandCorrelator;
  private readonly sessions = new Set<ClientSession>();
  /** Commands the order service has answered; each is acked once the store shows the status it set. */
  private readonly awaitingApply = new Map<string, { orderId: string; status: OrderStatus | undefined }>();
  private currentStage: Stage = 'catchup';
  private stageStarted = performance.now();
  private caughtUp = false;
  private lastEntryAt = performance.now();
  private readonly ignored = { delete: 0, invalid: 0 };
  private reported = { applied: 0, stale: 0, delete: 0, invalid: 0 };
  private readonly subscriptions: BusSubscription[] = [];
  private timers: ReturnType<typeof setInterval>[] = [];
  private flushing = false;
  private refreshing = false;
  private rebuilding = false;
  private attachTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private attached = false;
  private currentPreset: LoadPreset | null = null;

  constructor(private readonly options: LiveRuntimeOptions) {
    this.live = new LiveStore(options.store, options.log);
    this.commands = new CommandCorrelator(options.commandTimeoutMs);
    this.maxTrackedBlocks = options.maxTrackedBlocks;
    this.backpressure = options.backpressure ?? DEFAULT_BACKPRESSURE;
    this.summaryIntervalMs = options.summaryIntervalMs ?? 1_000;
  }

  get stage(): Stage {
    return this.currentStage;
  }

  /** Records the order service published that this process read but did not apply. */
  get ignoredCounts(): { stale: number; delete: number; invalid: number } {
    return { stale: this.live.stats.recordsStale, ...this.ignored };
  }

  /** True once the bus subscriptions are in place. */
  get isAttached(): boolean {
    return this.attached;
  }

  get clientCount(): number {
    return this.sessions.size;
  }

  /** Clients that have said hello, by negotiated codec. */
  clientsByCodec(): { json: number; msgpack: number } {
    const counts = { json: 0, msgpack: 0 };
    for (const s of this.sessions) counts[s.codecName === 'msgpack' ? 'msgpack' : 'json']++;
    return counts;
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
    void this.bootstrap();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.attachTimer !== null) clearTimeout(this.attachTimer);
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const sub of this.subscriptions) await sub.close().catch(() => undefined);
    this.subscriptions.length = 0;
    await this.options.snapshot?.watch.close().catch(() => undefined);
    this.flush();
    this.commands.clear();
    this.system.stop();
  }

  // ---- LiveHooks (what sessions use)

  register(session: ClientSession): void {
    this.sessions.add(session);
  }

  unregister(session: ClientSession): void {
    this.sessions.delete(session);
    this.commands.dropOwner(session);
  }

  /**
   * Sends a trader command to hermes. A fast pre-check against the store answers an unknown order or an
   * impossible transition at once; otherwise the command is published to `orders.commands` and `settle` is
   * called when the matching UPDATE has been applied (ok), hermes rejects it, or it times out. Hermes stays
   * authoritative: the pre-check can be stale, so a command that passes it may still be rejected.
   */
  command(request: CommandRequest, settle: (outcome: CommandOutcome) => void): void {
    const status = this.live.statusOf(request.orderId);
    if (status === undefined) {
      settle({ ok: false, code: 'UNKNOWN_ORDER', message: `Order ${request.orderId} does not exist` });
      return;
    }
    if (!canApplyCommand(status, request.action)) {
      settle({
        ok: false,
        code: 'INVALID_TRANSITION',
        message: `Cannot ${request.action.toLowerCase()} an order that is ${status}`,
      });
      return;
    }
    const commandId = makeCommandId(request.clientId, request.reqId);
    const { metrics } = this.options;
    const started = performance.now();
    const timed = (outcome: CommandOutcome): void => {
      metrics?.command(outcome.ok ? 'ok' : outcome.code, (performance.now() - started) / 1000);
      settle(outcome);
    };
    if (!this.commands.register(commandId, request.owner, timed)) {
      settle({ ok: false, code: 'BAD_REQUEST', message: `Command ${commandId} is already in progress` });
      return;
    }
    const payload: OrderCommand = {
      orderId: request.orderId,
      action: request.action,
      requestedBy: request.clientId,
      ts: Date.now(),
      commandId,
    };
    metrics?.ingest('command');
    this.options.bus.publish(SUBJECTS.ordersCommands, payload).catch((error: unknown) => {
      this.options.log.error({ err: error, commandId }, 'failed to publish order command');
      this.commands.resolve(commandId, { ok: false, code: 'INTERNAL', message: 'Could not send the command' });
    });
  }

  preset(): LoadPreset | null {
    return this.currentPreset;
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
      const age = this.live.lastFlushAgeMs;
      if (age !== null) this.options.metrics?.eventAge(age / 1000);
      const engine = this.options.engine;
      let changes: ViewChanges[] = [];
      if (cs.size > 0 || engine.hasDeferredWork()) {
        changes = engine.applyChanges(cs, this.options.flushBudgetMs ?? 40);
        this.options.metrics?.views(engine.stats().lastApply);
      }
      const byView = new Map<View, ViewChanges>(changes.map((c): [View, ViewChanges] => [c.view, c]));
      for (const session of [...this.sessions]) {
        try {
          session.onFlush({ cs, byView, now, store: this.options.store });
        } catch (error) {
          this.options.log.error({ err: error }, 'session flush failed');
        }
      }
      // After the sessions have sent their deltas, so a client sees the status change before its ack.
      this.settleAppliedCommands();
      this.reportRecords();
      const ms = performance.now() - t0;
      this.options.metrics?.flush(ms / 1000);
      const s = this.flushStats;
      s.flushes++;
      s.lastMs = ms;
      s.maxMs = Math.max(s.maxMs, ms);
      s.totalMs += ms;
      s.lastChanges = cs.size;
      s.totalChanges += cs.size;
      s.lastViews = changes.length;
      this.scheduleRebuilds();
    } catch (error) {
      this.options.log.error({ err: error }, 'flush failed');
    } finally {
      this.flushing = false;
    }
  }

  // ---- deferred view rebuilds

  /**
   * Views a tick could not patch (too many structural changes) are rebuilt after the tick's deltas have gone out,
   * each at most once a second and one per event-loop turn, so the loop stays responsive. The clients that track a
   * rebuilt view are told to refresh every route they hold.
   */
  private scheduleRebuilds(): void {
    if (this.rebuilding || this.stopped || this.options.engine.takeRebuild() === null) return;
    this.rebuilding = true;
    void (async (): Promise<void> => {
      try {
        for (;;) {
          await yieldToLoop();
          if (this.stopped) return;
          const view = this.options.engine.takeRebuild();
          if (view === null) return;
          const t0 = performance.now();
          this.options.engine.rebuildView(view);
          this.options.metrics?.rebuild((performance.now() - t0) / 1000);
          for (const session of this.sessions) session.onViewRebuilt(view);
        }
      } catch (error) {
        this.options.log.error({ err: error }, 'deferred view rebuild failed');
      } finally {
        this.rebuilding = false;
      }
    })();
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

  private setStage(stage: Stage): void {
    const now = performance.now();
    const seconds = (now - this.stageStarted) / 1000;
    this.options.metrics?.startup(this.currentStage, seconds);
    this.options.onStage?.(this.currentStage, seconds);
    this.options.log.info({ stage: this.currentStage, seconds }, 'startup stage finished');
    this.currentStage = stage;
    this.stageStarted = now;
  }

  /** Reports what the store did with records since the last flush to the metrics. */
  private reportRecords(): void {
    const s = this.live.stats;
    const next = { applied: s.recordsApplied, stale: s.recordsStale, delete: this.ignored.delete, invalid: this.ignored.invalid };
    const was = this.reported;
    this.reported = next;
    const ignored = { stale: next.stale - was.stale, delete: next.delete - was.delete, invalid: next.invalid - was.invalid };
    if (next.applied !== was.applied || ignored.stale + ignored.delete + ignored.invalid > 0) {
      this.options.metrics?.records({ applied: next.applied - was.applied, ignored });
    }
  }

  /** A command's answer: a REJECT fails it at once; an UPDATE waits until the store shows the status it set. */
  private correlate(event: OrderEvent): void {
    if (event.type === 'REJECT') {
      this.commands.resolve(event.commandId, { ok: false, code: event.code, message: event.message });
    } else if (event.type === 'UPDATE' && event.commandId !== undefined && this.commands.has(event.commandId)) {
      this.awaitingApply.set(event.commandId, { orderId: event.order.orderId, status: event.order.status });
    }
  }

  private settleAppliedCommands(): void {
    for (const [commandId, waiting] of this.awaitingApply) {
      if (!this.commands.has(commandId)) this.awaitingApply.delete(commandId);
      else if (waiting.status === undefined || this.live.statusOf(waiting.orderId) === waiting.status) {
        this.awaitingApply.delete(commandId);
        this.commands.resolve(commandId, { ok: true });
      }
    }
  }

  /**
   * Runs the startup stages after the snapshot: attach to the bus, catch up on the order-state changes made while
   * the snapshot loaded, take the latest price of every pair, then become ready.
   */
  private async bootstrap(): Promise<void> {
    await this.attach();
    if (this.stopped) return;
    if (this.options.snapshot !== undefined) void this.watchLoop(this.options.snapshot);
    await this.waitCaughtUp();
    if (this.stopped) return;
    this.setStage('prices');
    await this.loadLastPrices();
    await this.waitForPrices();
    if (this.stopped) return;
    this.flush();
    this.setStage('ready');
  }

  /** Feeds every watch entry after the initial values to the store's queue. */
  private async watchLoop(handoff: WatchHandoff): Promise<void> {
    const max = this.options.catchupMaxPending ?? 100;
    try {
      for (;;) {
        const step = await handoff.entries.next();
        if (step.done === true) break;
        const entry = step.value;
        this.lastEntryAt = performance.now();
        if (entry.delta <= max) this.caughtUp = true;
        if (entry.op !== 'PUT') {
          this.ignored.delete++;
          continue;
        }
        const record = readRecord(entry.value);
        if (record === null) {
          this.ignored.invalid++;
          continue;
        }
        this.options.metrics?.ingest('order');
        this.live.enqueueRecord(record, entry.revision);
      }
    } catch (error) {
      if (!this.stopped) this.options.log.error({ err: error }, 'order-state watch failed');
    }
    if (!this.stopped) {
      this.options.log.error({}, 'order-state watch ended');
      this.options.onFatal?.('the order-state watch ended');
    }
  }

  /** Caught up when an entry reports few pending behind it, or nothing has arrived for a moment. */
  private async waitCaughtUp(): Promise<void> {
    if (this.options.snapshot === undefined) return;
    const started = performance.now();
    while (!this.stopped && !this.caughtUp) {
      const now = performance.now();
      if (now - started >= 300 && now - this.lastEntryAt >= 250) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  /** The latest tick of every pair, from the stream that keeps one message per subject. */
  private async loadLastPrices(): Promise<void> {
    const { bus, log } = this.options;
    for (let attempt = 0; !this.stopped && attempt < 5; attempt++) {
      try {
        for (const message of await bus.lastPerSubject(STREAMS.prices, SUBJECTS.pricesWildcard)) {
          const parsed = parsePriceTick(message.payload);
          if (parsed.ok) this.live.enqueueTick(parsed.value);
        }
        return;
      } catch (error) {
        log.warn({ err: error, attempt }, 'could not read the last prices');
        await new Promise<void>((resolve) => setTimeout(resolve, this.options.retryMs ?? 1_000));
      }
    }
  }

  private async waitForPrices(): Promise<void> {
    const deadline = performance.now() + (this.options.priceWaitMs ?? 10_000);
    while (!this.stopped && this.live.pairsWithPrice < CURRENCY_PAIRS.length && performance.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    const missing = CURRENCY_PAIRS.filter((pair) => !(pair in this.live.lastTickTs()));
    if (missing.length > 0) this.options.log.warn({ missing }, 'starting without a price for some pairs');
  }

  private async attach(): Promise<void> {
    if (this.stopped) return;
    const { bus, log } = this.options;
    try {
      const prices = await bus.subscribe(SUBJECTS.pricesWildcard, (payload) => {
        const parsed = parsePriceTick(payload);
        if (!parsed.ok) return;
        this.live.enqueueTick(parsed.value);
        this.options.metrics?.ingest('price');
      });
      this.subscriptions.push(prices);
      const state = await bus.subscribe(SUBJECTS.controlState, (payload) => {
        const parsed = parseLoadState(payload);
        if (parsed.ok) this.currentPreset = parsed.value.preset;
      });
      this.subscriptions.push(state);
      // Until commands go through the order service (phase 1.5c), the answer to a command is still an event on
      // `orders.events`. Listened to plain: this is not a consumer and holds no position in the stream.
      const answers = await bus.subscribe(SUBJECTS.ordersEvents, (payload) => {
        const parsed = parseOrderEvent(payload);
        if (parsed.ok) this.correlate(parsed.value);
      });
      this.subscriptions.push(answers);
      this.attached = true;
      log.info({}, 'attached to the message bus');
    } catch (error) {
      for (const sub of this.subscriptions.splice(0)) await sub.close().catch(() => undefined);
      log.warn({ err: error }, 'could not attach to the message bus yet, retrying');
      await new Promise<void>((resolve) => {
        this.attachTimer = setTimeout(resolve, this.options.retryMs ?? 2_000);
      });
      await this.attach();
    }
  }
}
