import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startHelios, type Helios } from '@apeiron/helios/helios';
import { startHermes, type Hermes } from '@apeiron/hermes/hermes';
import {
  BUCKETS,
  SUBJECTS,
  mulberry32,
  parseOrderStateRecord,
  type Bus,
  type BusHandler,
  type BusSubscription,
  type CommandAction,
  type ConsumeHandler,
  type ConsumeSpec,
  type CurrencyPair,
  type KvBucket,
  type KvWatch,
  type LoadPreset,
  type Order,
  type OrderCommandRequest,
  type OrderStateRecord,
  type ExecReport,
  type PriceTick,
  type RequestHandler,
  type StoredMessage,
} from '@apeiron/logos';
import { OrderModel } from './model';

const run = promisify(execFile);

function repoRoot(): string {
  return new URL('../../', import.meta.url).pathname;
}

/** Stops the real hermes so the driver is the only publisher of orders. Safe to call twice. */
export async function stopHermesContainer(): Promise<void> {
  await run('docker', ['compose', '--profile', 'core', 'stop', 'hermes'], { cwd: repoRoot() });
}

/** Starts the real hermes again; teardown calls it whether or not the scenario passed. */
export async function startHermesContainer(): Promise<void> {
  await run('docker', ['compose', '--profile', 'core', 'start', 'hermes'], { cwd: repoRoot() });
}

/** Stops the real price feed so the driver is the only publisher of prices. Safe to call twice. */
export async function stopHeliosContainer(): Promise<void> {
  await run('docker', ['compose', '--profile', 'core', 'stop', 'helios'], { cwd: repoRoot() });
}

/** Starts the real price feed again; teardown calls it whether or not the scenario passed. */
export async function startHeliosContainer(): Promise<void> {
  await run('docker', ['compose', '--profile', 'core', 'start', 'helios'], { cwd: repoRoot() });
}

export type DriverRate = 'normal' | 'stress';
/** The driver runs hermes's own presets: normal is Appendix E's medium, stress its stress. */
export const RATE_PRESET: Readonly<Record<DriverRate, LoadPreset>> = { normal: 'medium', stress: 'stress' };

export type DriverStats = {
  events: number;
  ticks: number;
  /** Publishes that failed; any value above zero invalidates the run, since the model holds an event the bus never got. */
  publishErrors: number;
  /** Publishes that failed once and then got through; they are not errors, but a run with many says the bus is struggling. */
  publishRetries: number;
  /** The first distinct messages of those failures, so a failed run says why. */
  publishErrorSamples: string[];
  created: number;
  commands: { pause: number; resume: number };
};

export type DriverRepo = {
  loadOpen(): Promise<{ order: Order; v: number; execSeq: number }[]>;
  /** Where the price walk starts: the latest market mid per pair among the open orders. */
  latestMidsByPair(): Promise<Record<CurrencyPair, number>>;
  maxOrderId(): Promise<string | null>;
};

export type DriverOptions = {
  bus: Bus;
  repo: DriverRepo;
  seed: number;
  rate: DriverRate;
  /** Hermes step length (default 100 ms). */
  stepMs?: number;
  /** One PAUSE every this long (default 1000 ms); each is resumed `resumeAfterMs` later. Zero turns it off. */
  pauseEveryMs?: number;
  resumeAfterMs?: number;
  /** Added to the local clock for every timestamp the driver stamps, so the stream follows the server's clock. */
  clockOffsetMs?: number;
  /** Tries per publish before it counts as failed (default 3). */
  publishAttempts?: number;
  /** Wait before a retry, times the attempt number (default 250 ms). */
  retryDelayMs?: number;
};

export type Driver = {
  start(): Promise<void>;
  /** Stops the stream, waits for every publish to settle, then publishes a last tick per pair. The record stream stays open. */
  stop(): Promise<void>;
  /** Waits until no record has reached the model for `quietMs` (the order service has caught up with what was published). */
  settled(quietMs?: number, timeoutMs?: number): Promise<void>;
  /** Stops, and closes the record stream. */
  dispose(): Promise<void>;
  setRate(rate: DriverRate): void;
  /** Silences the price feed (nothing is published and the model sees no ticks), as if helios were down; false brings it back. */
  pausePrices(paused: boolean): void;
  model(): OrderModel;
  stats(): DriverStats;
  /** The highest order id before the stream started (every created order is above it), or null for an empty database. */
  startMaxOrderId(): string | null;
  /** The time the stream started, on the driver's (server-aligned) clock. */
  startedAt(): number;
  /** What the venue sent: every execution report that reached the bus, per order in publish order, and each order's record before its first. */
  venueLog(): VenueLog;
};

export type VenueLog = {
  reports: ReadonlyMap<string, readonly ExecReport[]>;
  startOf(orderId: string): OrderStateRecord | undefined;
};

const SILENT = {
  error: (): void => undefined,
  warn: (): void => undefined,
  info: (): void => undefined,
  debug: (): void => undefined,
};

/**
 * The deterministic update driver. It runs hermes and helios in-process on a seeded generator, through a bus that applies
 * every tick it publishes to an independent {@link OrderModel}, and adds PAUSE and RESUME commands through the normal
 * command path. hermes's reports go to the real order service, which publishes the resulting records to `ORDER_STATE`;
 * the model is fed from that record stream (the blotter's own source), so what is checked is the path from the bucket to
 * the blotter and on to the screen. hermes's generator, the lifecycle maths in logos and the model are shared code.
 */
export function createDriver(options: DriverOptions): Driver {
  const model: { current: OrderModel } = { current: new OrderModel([]) };
  const stats: DriverStats = { events: 0, ticks: 0, publishErrors: 0, publishRetries: 0, publishErrorSamples: [], created: 0, commands: { pause: 0, resume: 0 } };
  const offset = options.clockOffsetMs ?? 0;
  const now = (): number => Date.now() + offset;
  const pending = new Set<Promise<void>>();
  let hermes: Hermes | null = null;
  let helios: Helios | null = null;
  let injector: ReturnType<typeof setInterval> | null = null;
  let startMax: string | null = null;
  let startedAt = 0;
  let watch: KvWatch | null = null;
  let lastRecordAt = 0;
  let commandSeq = 0;
  const resumes: { orderId: string; at: number }[] = [];
  let pricesPaused = false;
  const reportLog = new Map<string, ExecReport[]>();
  /** The record of each order before the stream's first report for it: the database's at the start, or the order service's first for a new order. */
  const startRecords = new Map<string, OrderStateRecord>();

  const track = (promise: Promise<void>): void => {
    const settled = promise.catch((error: unknown) => {
      stats.publishErrors += 1;
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (stats.publishErrorSamples.length < 5 && !stats.publishErrorSamples.includes(message)) stats.publishErrorSamples.push(message);
    });
    pending.add(settled);
    void settled.finally(() => {
      pending.delete(settled);
    });
  };

  const attempts = options.publishAttempts ?? 3;
  const retryDelay = options.retryDelayMs ?? 250;
  /** The last publish queued for each order; the next one for that order waits for it (see {@link publishWithRetry}). */
  const tails = new Map<string, Promise<void>>();

  const orderOf = (subject: string, payload: unknown): string | null => {
    if (subject !== SUBJECTS.execReports) return null;
    return (payload as ExecReport).orderId;
  };

  const attempt = async (subject: string, payload: unknown): Promise<void> => {
    for (let n = 1; ; n += 1) {
      try {
        await options.bus.publish(subject, payload);
        if (n > 1) stats.publishRetries += 1;
        return;
      } catch (error) {
        if (n >= attempts) throw error;
        await new Promise<void>((resolve) => {
          setTimeout(resolve, retryDelay * n);
        });
      }
    }
  };

  /**
   * Publishes, retrying a failure a couple of times, because one JetStream ack can time out while the bus is busy.
   * Events carry absolute values, so a retried event must not land after a newer one for the same order: each order's
   * publishes go out one after another, and only a publish that fails every attempt counts as failed.
   */
  const publishWithRetry = (subject: string, payload: unknown): Promise<void> => {
    const order = orderOf(subject, payload);
    if (order === null) return attempt(subject, payload);
    const previous = tails.get(order);
    const run = previous === undefined ? attempt(subject, payload) : previous.then(() => attempt(subject, payload), () => attempt(subject, payload));
    tails.set(order, run);
    const forget = (): void => {
      if (tails.get(order) === run) tails.delete(order);
    };
    run.then(forget, forget);
    return run;
  };

  const tee: Bus = {
    publish(subject: string, payload: unknown): Promise<void> {
      if (subject.startsWith('prices.')) {
        if (pricesPaused) return Promise.resolve();
        model.current.applyTick(payload as PriceTick);
        stats.ticks += 1;
      }
      const published = publishWithRetry(subject, payload);
      if (subject === SUBJECTS.execReports) {
        const report = payload as ExecReport;
        void published.then(() => {
          reportLog.set(report.orderId, [...(reportLog.get(report.orderId) ?? []), report]);
        }, () => undefined);
      }
      if (subject === SUBJECTS.execReports || subject.startsWith('prices.')) track(published);
      return published;
    },
    subscribe: (subject: string, handler: BusHandler): Promise<BusSubscription> => options.bus.subscribe(subject, handler),
    consume: (spec: ConsumeSpec, handler: ConsumeHandler): Promise<BusSubscription> => options.bus.consume(spec, handler),
    request: (subject: string, payload: unknown, timeoutMs: number): Promise<unknown> => options.bus.request(subject, payload, timeoutMs),
    serve: (subject: string, handler: RequestHandler): Promise<BusSubscription> => options.bus.serve(subject, handler),
    kv: (bucket: string): KvBucket => options.bus.kv(bucket),
    lastPerSubject: (stream: string, filter: string): Promise<StoredMessage[]> => options.bus.lastPerSubject(stream, filter),
    close: (): Promise<void> => Promise.resolve(),
  };

  const sendCommand = (orderId: string, action: CommandAction): void => {
    commandSeq += 1;
    const command: OrderCommandRequest = { commandId: `driver:${commandSeq}`, userId: 'driver', orderId, kind: 'action', action };
    stats.commands[action === 'PAUSE' ? 'pause' : 'resume'] += 1;
    // The order service decides; a refusal (the order finished meanwhile) or a late reply is an answer, not a failure of the run.
    options.bus.request(SUBJECTS.ordersCmd, command, 5_000).catch(() => undefined);
  };

  const inject = (pick: () => number): void => {
    const t = now();
    for (let i = resumes.length - 1; i >= 0; i -= 1) {
      const due = resumes[i];
      if (due !== undefined && due.at <= t) {
        resumes.splice(i, 1);
        if (model.current.statusOf(due.orderId) === 'PAUSED') sendCommand(due.orderId, 'RESUME');
      }
    }
    const live = model.current.liveIds();
    const target = live[Math.floor(pick() * live.length)];
    if (target === undefined) return;
    sendCommand(target, 'PAUSE');
    resumes.push({ orderId: target, at: t + (options.resumeAfterMs ?? 3000) });
  };

  return {
    async start(): Promise<void> {
      const open = await options.repo.loadOpen();
      const current = open.map((record) => record.order);
      for (const stored of open) startRecords.set(stored.order.orderId, { v: stored.v, execSeq: stored.execSeq, srcTs: stored.order.lastUpdateTime, order: stored.order });
      startMax = await options.repo.maxOrderId();
      model.current = new OrderModel(current);
      startedAt = now();
      // The model follows the order service's record stream from before anything is published.
      watch = await options.bus.kv(BUCKETS.orderState).watch({ updatesOnly: true });
      const records = watch;
      void (async (): Promise<void> => {
        for await (const entry of records) {
          if (entry.op !== 'PUT') continue;
          const parsed = parseOrderStateRecord(entry.value);
          if (!parsed.ok) continue;
          const created = model.current.createdIds.length;
          if (!startRecords.has(parsed.value.order.orderId) && parsed.value.v === 1) startRecords.set(parsed.value.order.orderId, parsed.value);
          model.current.applyRecord(parsed.value);
          lastRecordAt = Date.now();
          stats.events = model.current.events;
          if (model.current.createdIds.length > created) stats.created += 1;
        }
      })().catch(() => undefined);
      // The price feed first, as in the stack: hermes follows its ticks for fill prices.
      helios = startHelios({
        bus: tee,
        log: SILENT,
        levels: await options.repo.latestMidsByPair(),
        seed: options.seed ^ 0x5bd1e995,
        now,
      });
      hermes = await startHermes({
        bus: tee,
        log: SILENT,
        preset: RATE_PRESET[options.rate],
        seed: options.seed,
        stepMs: options.stepMs ?? 100,
        now,
      });
      const every = options.pauseEveryMs ?? 1000;
      if (every > 0) {
        const rng = mulberry32(options.seed ^ 0x9e3779b9);
        injector = setInterval(() => {
          inject(rng);
        }, every);
      }
    },

    async stop(): Promise<void> {
      if (injector !== null) clearInterval(injector);
      injector = null;
      const running = hermes;
      const prices = helios;
      hermes = null;
      helios = null;
      if (running === null || prices === null) return;
      await running.stop();
      await prices.stop();
      await Promise.all([...pending]);
      // One last tick per pair, so the server's final price join and the model's agree on the quote.
      for (const tick of prices.feed.tick(now())) {
        track(tee.publish(`prices.${tick.pair}`, tick));
      }
      await Promise.all([...pending]);
    },

    async settled(quietMs = 750, timeoutMs = 30_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && Date.now() - lastRecordAt < quietMs) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        });
      }
    },

    async dispose(): Promise<void> {
      await this.stop();
      await watch?.close();
      watch = null;
    },

    pausePrices(paused: boolean): void {
      pricesPaused = paused;
    },

    setRate(rate: DriverRate): void {
      hermes?.simulator.setPreset(RATE_PRESET[rate], now());
    },

    model: () => model.current,
    stats: () => ({ ...stats, publishErrorSamples: [...stats.publishErrorSamples], commands: { ...stats.commands } }),
    startMaxOrderId: () => startMax,
    startedAt: () => startedAt,
    venueLog: () => ({ reports: reportLog, startOf: (orderId) => startRecords.get(orderId) }),
  };
}
