import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startHermes, type Hermes } from '@apeiron/hermes/hermes';
import {
  SUBJECTS,
  mulberry32,
  type Bus,
  type BusHandler,
  type BusSubscription,
  type CommandAction,
  type ConsumeHandler,
  type ConsumeSpec,
  type LoadPreset,
  type Order,
  type OrderCommand,
  type OrderEvent,
  type PriceTick,
} from '@apeiron/logos';
import { OrderModel } from './model';

const run = promisify(execFile);

function repoRoot(): string {
  return new URL('../../', import.meta.url).pathname;
}

/** Stops the real hermes so the driver is the only publisher. Safe to call twice. */
export async function stopHermesContainer(): Promise<void> {
  await run('docker', ['compose', '--profile', 'core', 'stop', 'hermes'], { cwd: repoRoot() });
}

/** Starts the real hermes again; teardown calls it whether or not the scenario passed. */
export async function startHermesContainer(): Promise<void> {
  await run('docker', ['compose', '--profile', 'core', 'start', 'hermes'], { cwd: repoRoot() });
}

export type DriverRate = 'normal' | 'stress';
/** The driver runs hermes's own presets: normal is Appendix E's medium, stress its stress. */
export const RATE_PRESET: Readonly<Record<DriverRate, LoadPreset>> = { normal: 'medium', stress: 'stress' };

export type DriverStats = {
  events: number;
  ticks: number;
  /** Publishes that failed; any value above zero invalidates the run, since the model holds an event the bus never got. */
  publishErrors: number;
  created: number;
  commands: { pause: number; resume: number };
};

export type DriverRepo = {
  loadCurrent(): Promise<Order[]>;
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
};

export type Driver = {
  start(): Promise<void>;
  /** Stops the stream, waits for every publish to settle, then publishes a last tick per pair. */
  stop(): Promise<void>;
  setRate(rate: DriverRate): void;
  model(): OrderModel;
  stats(): DriverStats;
  /** The highest order id before the stream started (every created order is above it), or null for an empty database. */
  startMaxOrderId(): string | null;
  /** The time the stream started, on the driver's (server-aligned) clock. */
  startedAt(): number;
};

const SILENT = {
  error: (): void => undefined,
  warn: (): void => undefined,
  info: (): void => undefined,
  debug: (): void => undefined,
};

/**
 * The deterministic update driver. It runs hermes in-process on a seeded generator, through a bus that applies every
 * event and tick it publishes to an independent {@link OrderModel} before forwarding it, and adds PAUSE and RESUME
 * commands through the normal command path. Hermes's generator, the lifecycle maths in logos and the model are all
 * shared code; nothing here reimplements them.
 */
export function createDriver(options: DriverOptions): Driver {
  const model: { current: OrderModel } = { current: new OrderModel([]) };
  const stats: DriverStats = { events: 0, ticks: 0, publishErrors: 0, created: 0, commands: { pause: 0, resume: 0 } };
  const offset = options.clockOffsetMs ?? 0;
  const now = (): number => Date.now() + offset;
  const pending = new Set<Promise<void>>();
  let hermes: Hermes | null = null;
  let injector: ReturnType<typeof setInterval> | null = null;
  let startMax: string | null = null;
  let startedAt = 0;
  let commandSeq = 0;
  const resumes: { orderId: string; at: number }[] = [];

  const track = (promise: Promise<void>): void => {
    const settled = promise.catch(() => {
      stats.publishErrors += 1;
    });
    pending.add(settled);
    void settled.finally(() => {
      pending.delete(settled);
    });
  };

  const tee: Bus = {
    publish(subject: string, payload: unknown): Promise<void> {
      if (subject === SUBJECTS.ordersEvents) {
        const event = payload as OrderEvent;
        model.current.applyEvent(event);
        if (event.type !== 'REJECT') stats.events += 1;
        if (event.type === 'NEW') stats.created += 1;
      } else if (subject.startsWith('prices.')) {
        model.current.applyTick(payload as PriceTick);
        stats.ticks += 1;
      }
      const published = options.bus.publish(subject, payload);
      if (subject === SUBJECTS.ordersEvents || subject.startsWith('prices.')) track(published);
      return published;
    },
    subscribe: (subject: string, handler: BusHandler): Promise<BusSubscription> => options.bus.subscribe(subject, handler),
    consume: (spec: ConsumeSpec, handler: ConsumeHandler): Promise<BusSubscription> => options.bus.consume(spec, handler),
    close: (): Promise<void> => Promise.resolve(),
  };

  const sendCommand = (orderId: string, action: CommandAction): void => {
    commandSeq += 1;
    const command: OrderCommand = { orderId, action, requestedBy: 'driver', ts: now(), commandId: `driver:${commandSeq}` };
    stats.commands[action === 'PAUSE' ? 'pause' : 'resume'] += 1;
    track(options.bus.publish(SUBJECTS.ordersCommands, command));
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
      const current = await options.repo.loadCurrent();
      startMax = await options.repo.maxOrderId();
      model.current = new OrderModel(current);
      startedAt = now();
      hermes = await startHermes({
        bus: tee,
        log: SILENT,
        preset: RATE_PRESET[options.rate],
        current,
        maxOrderId: startMax,
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
      hermes = null;
      if (running === null) return;
      await running.stop();
      await Promise.all([...pending]);
      // One last tick per pair, so the server's final price join and the model's agree on the quote.
      for (const tick of running.feed.tick(now())) {
        track(tee.publish(`prices.${tick.pair}`, tick));
      }
      await Promise.all([...pending]);
    },

    setRate(rate: DriverRate): void {
      hermes?.simulator.setPreset(RATE_PRESET[rate], now());
    },

    model: () => model.current,
    stats: () => ({ ...stats, commands: { ...stats.commands } }),
    startMaxOrderId: () => startMax,
    startedAt: () => startedAt,
  };
}
