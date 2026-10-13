import { mulberry32, priceSubject, type Bus, type PriceTick } from '@apeiron/logos';
import type { Logger } from './log.js';
import type { HeliosMetrics } from './metrics.js';
import { PriceFeed } from './price-feed.js';
import { TICKS_PER_SECOND } from './presets.js';
import type { CurrencyPair } from '@apeiron/logos';

export type HeliosOptions = {
  bus: Bus;
  log: Logger;
  /** Where each pair's walk starts. */
  levels: Readonly<Record<CurrencyPair, number>>;
  seed: number;
  now?: () => number;
  metrics?: HeliosMetrics;
  /** How often the loop looks at the clock (default 50 ms); ticks are on a fixed grid whatever this is. */
  loopMs?: number;
};

export type HeliosStatus = { status: 'ok' | 'stopped'; ticksPublished: number; publishErrors: number };

export type Helios = {
  stop(): Promise<void>;
  status(): HeliosStatus;
  feed: PriceFeed;
};

/** The price feed: a random walk per pair, published as `prices.<PAIR>` at 3 ticks per second each. Knows nothing about orders. */
export function startHelios(options: HeliosOptions): Helios {
  const { bus, log } = options;
  const now = options.now ?? ((): number => Date.now());
  const feed = new PriceFeed(mulberry32(options.seed), options.levels);
  let ticksPublished = 0;
  let publishErrors = 0;
  let stopped = false;

  const publish = (tick: PriceTick): void => {
    bus.publish(priceSubject(tick.pair), tick).then(
      () => {
        ticksPublished++;
        options.metrics?.tick();
      },
      (error: unknown) => {
        publishErrors++;
        options.metrics?.publishError();
        if (publishErrors === 1 || publishErrors % 1000 === 0) log.warn({ err: error, publishErrors }, 'publish failed');
      },
    );
  };
  const publishTicks = (): void => {
    for (const tick of feed.tick(now())) publish(tick);
  };

  publishTicks();
  const tickEveryMs = 1000 / TICKS_PER_SECOND;
  let nextTickAt = now() + tickEveryMs;
  const timer = setInterval(() => {
    if (stopped) return;
    const t = now();
    if (t < nextTickAt) return;
    // Advance on a fixed grid so the average rate is 3/s however coarse the loop is.
    nextTickAt = Math.max(nextTickAt + tickEveryMs, t + 1);
    publishTicks();
  }, options.loopMs ?? 50);

  return {
    feed,
    status: (): HeliosStatus => ({ status: stopped ? 'stopped' : 'ok', ticksPublished, publishErrors }),
    stop: (): Promise<void> => {
      stopped = true;
      clearInterval(timer);
      return Promise.resolve();
    },
  };
}
