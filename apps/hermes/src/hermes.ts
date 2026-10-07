import {
  SUBJECTS,
  mulberry32,
  parseLoadControl,
  priceSubject,
  type Bus,
  type BusSubscription,
  type LoadPreset,
  type Order,
  type OrderEvent,
} from '@apeiron/logos';
import type { Logger } from './log.js';
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
};

export type HermesStatus = {
  status: 'ok' | 'stopped';
  preset: LoadPreset;
  live: number;
  pending: number;
  eventsPublished: number;
  ticksPublished: number;
  publishErrors: number;
  inflight: number;
};

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

  const publish = (subject: string, payload: unknown, kind: 'event' | 'tick'): void => {
    inflight++;
    bus
      .publish(subject, payload)
      .then(() => {
        if (kind === 'event') eventsPublished++;
        else ticksPublished++;
      })
      .catch((error: unknown) => {
        publishErrors++;
        if (publishErrors === 1 || publishErrors % 1000 === 0) log.warn({ err: error, publishErrors }, 'publish failed');
      })
      .finally(() => {
        inflight--;
      });
  };

  const simulator = new Simulator({
    rng,
    feed,
    preset: options.preset,
    current: options.current,
    startSeq: nextSeqFrom(options.maxOrderId),
    emit: (event: OrderEvent): void => publish(SUBJECTS.ordersEvents, event, 'event'),
  });

  // Prices first, so reconciliation fills and new orders use the starting levels.
  const publishTicks = (): void => {
    for (const tick of feed.tick(now())) publish(priceSubject(tick.pair), tick, 'tick');
  };
  publishTicks();

  const reconciled = simulator.reconcile(now());
  log.info(
    { ...reconciled, live: simulator.liveCount, pending: simulator.pendingCount, preset: simulator.preset },
    'reconciled current orders',
  );

  let control: BusSubscription | null = null;
  control = await bus.subscribe(SUBJECTS.controlLoad, (payload) => {
    const parsed = parseLoadControl(payload);
    if (!parsed.ok) {
      log.warn({ error: parsed.error }, 'ignored invalid control.load message');
      return;
    }
    simulator.setPreset(parsed.value.preset, now());
    log.info({ preset: parsed.value.preset, live: simulator.liveCount }, 'load preset changed');
  });

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

  return {
    simulator,
    feed,
    status: (): HermesStatus => ({
      status: stopped ? 'stopped' : 'ok',
      preset: simulator.preset,
      live: simulator.liveCount,
      pending: simulator.pendingCount,
      eventsPublished,
      ticksPublished,
      publishErrors,
      inflight,
    }),
    stop: async (): Promise<void> => {
      stopped = true;
      clearInterval(timer);
      await control?.close();
    },
  };
}
