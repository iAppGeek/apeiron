import {
  CONSUMERS,
  STREAMS,
  SUBJECTS,
  parseOrderCommand,
  mulberry32,
  parseLoadControl,
  type LoadState,
  priceSubject,
  type Bus,
  type BusSubscription,
  type LoadPreset,
  type Order,
  type OrderEvent,
} from '@apeiron/logos';
import type { Logger } from './log.js';
import type { HermesMetrics } from './metrics.js';
import { PriceFeed, startingMids } from './price-feed.js';
import { TICKS_PER_SECOND } from './presets.js';
import { Simulator, nextSeqFrom } from './simulator.js';

export type HermesOptions = {
  bus: Bus;
  log: Logger;
  preset: LoadPreset;
  /** `loadCurrent()` result. */
  current: readonly Order[];
  /** `maxOrderId()` result. */
  maxOrderId: string | null;
  seed: number;
  stepMs: number;
  now?: () => number;
  metrics?: HermesMetrics;
};

export type HermesStatus = {
  status: 'ok' | 'stopped';
  preset: LoadPreset;
  live: number;
  pending: number;
  eventsPublished: number;
  commandsHandled: number;
  ticksPublished: number;
  publishErrors: number;
  inflight: number;
};

/** How often hermes repeats `control.state`, so a server that starts later learns the preset within this long. */
export const STATE_INTERVAL_MS = 5_000;

/** A command older than this when hermes sees it is dropped: the server has already timed it out. */
export const COMMAND_MAX_AGE_MS = 30_000;

/** Publishes beyond this many unacknowledged messages are held back until the backlog drains. */
export const MAX_INFLIGHT = 20_000;

export type Hermes = {
  stop(): Promise<void>;
  status(): HermesStatus;
  simulator: Simulator;
  feed: PriceFeed;
};

/**
 * Wires the price feed and lifecycle simulator to a bus: reconciles stale orders at startup, publishes
 * `prices.<PAIR>` at 3 ticks/s per pair and `orders.events` at the preset rate, and follows `control.load`.
 */
export async function startHermes(options: HermesOptions): Promise<Hermes> {
  const { bus, log } = options;
  const now = options.now ?? ((): number => Date.now());
  const rng = mulberry32(options.seed);
  const feed = new PriceFeed(rng, startingMids(options.current));
  let eventsPublished = 0;
  let ticksPublished = 0;
  let publishErrors = 0;
  let inflight = 0;
  let stopped = false;

  /** Resolves true once the broker has the message, false if the publish failed. Never rejects. */
  const publish = (subject: string, payload: unknown, kind: 'event' | 'tick'): Promise<boolean> => {
    inflight++;
    return bus
      .publish(subject, payload)
      .then(() => {
        if (kind === 'event') {
          eventsPublished++;
          options.metrics?.event((payload as OrderEvent).type);
        } else {
          ticksPublished++;
          options.metrics?.tick();
        }
        return true;
      })
      .catch((error: unknown) => {
        publishErrors++;
        options.metrics?.publishError();
        if (publishErrors === 1 || publishErrors % 1000 === 0) log.warn({ err: error, publishErrors }, 'publish failed');
        return false;
      })
      .finally(() => {
        inflight--;
      });
  };

  let lastEventPublish: Promise<boolean> | null = null;

  const simulator = new Simulator({
    rng,
    feed,
    preset: options.preset,
    current: options.current,
    startSeq: nextSeqFrom(options.maxOrderId),
    emit: (event: OrderEvent): void => {
      lastEventPublish = publish(SUBJECTS.ordersEvents, event, 'event');
    },
  });

  // Prices first, so reconciliation fills and new orders use the starting levels.
  const publishTicks = (): void => {
    for (const tick of feed.tick(now())) void publish(priceSubject(tick.pair), tick, 'tick');
  };
  publishTicks();

  const reconciled = simulator.reconcile(now());
  log.info(
    { ...reconciled, live: simulator.liveCount, pending: simulator.pendingCount, preset: simulator.preset },
    'reconciled current orders',
  );

  const publishState = (): void => {
    const state: LoadState = { preset: simulator.preset };
    bus.publish(SUBJECTS.controlState, state).catch((error: unknown) => {
      log.warn({ err: error }, 'publish control.state failed');
    });
  };
  publishState();
  const stateTimer = setInterval(publishState, STATE_INTERVAL_MS);

  let control: BusSubscription | null = null;
  control = await bus.subscribe(SUBJECTS.controlLoad, (payload) => {
    const parsed = parseLoadControl(payload);
    if (!parsed.ok) {
      log.warn({ error: parsed.error }, 'ignored invalid control.load message');
      return;
    }
    simulator.setPreset(parsed.value.preset, now());
    log.info({ preset: parsed.value.preset, live: simulator.liveCount }, 'load preset changed');
    publishState();
  });

  let commandsHandled = 0;
  const commands = await bus.consume(
    { stream: STREAMS.orders, durable: CONSUMERS.hermesCommands, subject: SUBJECTS.ordersCommands },
    (payload, _subject, ack) => {
      const parsed = parseOrderCommand(payload);
      if (!parsed.ok) {
        log.warn({ error: parsed.error }, 'dropped invalid order command');
        ack();
        return;
      }
      const command = parsed.value;
      const t = now();
      if (t - command.ts > COMMAND_MAX_AGE_MS) {
        log.warn({ commandId: command.commandId, ageMs: t - command.ts }, 'dropped stale order command');
        ack();
        return;
      }
      lastEventPublish = null;
      simulator.command(command, t);
      commandsHandled++;
      options.metrics?.commandHandled();
      // Acknowledge only once the answering event is on the stream; otherwise the command is redelivered.
      void (lastEventPublish ?? Promise.resolve(true)).then((published) => {
        if (published) ack();
      });
    },
  );

  let last = now();
  const tickEveryMs = 1000 / TICKS_PER_SECOND;
  let nextTickAt = last + tickEveryMs;
  const timer = setInterval(() => {
    if (stopped) return;
    const t = now();
    const dt = Math.min(t - last, 1_000);
    last = t;
    if (t >= nextTickAt) {
      // Advance on a fixed grid so the average rate is 3/s however coarse the step is.
      nextTickAt = Math.max(nextTickAt + tickEveryMs, t + 1);
      publishTicks();
    }
    if (inflight > MAX_INFLIGHT) {
      log.warn({ inflight }, 'publish backlog, skipping simulation step');
      return;
    }
    simulator.step(t, dt);
  }, options.stepMs);

  const status = (): HermesStatus => ({
      status: stopped ? 'stopped' : 'ok',
      preset: simulator.preset,
      live: simulator.liveCount,
      pending: simulator.pendingCount,
      eventsPublished,
      commandsHandled,
      ticksPublished,
      publishErrors,
      inflight,
    });
  options.metrics?.bind(() => {
    const s = status();
    return { preset: s.preset, live: s.live, pending: s.pending, inflight: s.inflight };
  });

  return {
    simulator,
    feed,
    status,
    stop: async (): Promise<void> => {
      stopped = true;
      clearInterval(timer);
      clearInterval(stateTimer);
      await control?.close();
      await commands.close();
    },
  };
}
