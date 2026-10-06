import { PAIRS, PAIR_BY_NAME, normal, uniform, type CurrencyPair, type Order, type PriceTick, type Rng } from '@apeiron/logos';
import { TICKS_PER_SECOND } from './presets.js';

/** The walk is run faster than real FX so moves are visible: 5x the volatility a true per-tick scaling gives. */
const VOL_ACCELERATION = 5;
const SECONDS_PER_DAY = 86_400;
/** Pull back towards the starting level so a long session does not drift away from the seeded orders. */
const REVERSION = 2e-4;

const roundTo = (value: number, decimals: number): number => {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
};

/**
 * Each pair's starting mid: the `marketMid` of the most recently updated current order (so LIVE rows do not
 * jump on the first tick), falling back to the reference level for a pair with no current orders.
 */
export function startingMids(current: readonly Order[]): Record<CurrencyPair, number> {
  const latest = new Map<CurrencyPair, Order>();
  for (const order of current) {
    const seen = latest.get(order.currencyPair);
    if (seen === undefined || order.lastUpdateTime > seen.lastUpdateTime || (order.lastUpdateTime === seen.lastUpdateTime && order.orderId > seen.orderId)) {
      latest.set(order.currencyPair, order);
    }
  }
  return Object.fromEntries(PAIRS.map((p): [CurrencyPair, number] => [p.pair, latest.get(p.pair)?.marketMid ?? p.mid])) as Record<
    CurrencyPair,
    number
  >;
}

/** A random walk per pair with a G10 or EM spread (Appendix E), rounded to the pair's decimals. */
export class PriceFeed {
  private readonly mids = new Map<CurrencyPair, number>();
  private readonly anchors = new Map<CurrencyPair, number>();
  private readonly spreadBps = new Map<CurrencyPair, number>();
  private readonly last = new Map<CurrencyPair, PriceTick>();

  constructor(
    private readonly rng: Rng,
    start: Readonly<Record<CurrencyPair, number>>,
  ) {
    for (const p of PAIRS) {
      this.mids.set(p.pair, start[p.pair]);
      this.anchors.set(p.pair, start[p.pair]);
      this.spreadBps.set(p.pair, p.g10 ? uniform(rng, 0.5, 3) : uniform(rng, 5, 30));
    }
  }

  mid(pair: CurrencyPair): number {
    return this.mids.get(pair) as number;
  }

  /** The most recent tick for a pair, or undefined before the first `tick()`. */
  quote(pair: CurrencyPair): PriceTick | undefined {
    return this.last.get(pair);
  }

  /** Advances every pair by one tick and returns the new quotes. */
  tick(now: number): PriceTick[] {
    const ticks: PriceTick[] = [];
    for (const p of PAIRS) {
      const sigma = (p.dailyVol * VOL_ACCELERATION) / Math.sqrt(SECONDS_PER_DAY * TICKS_PER_SECOND);
      const anchor = this.anchors.get(p.pair) as number;
      let mid = this.mids.get(p.pair) as number;
      mid = mid * Math.exp(normal(this.rng, 0, sigma)) + (anchor - mid) * REVERSION;
      this.mids.set(p.pair, mid);
      const spread = (this.spreadBps.get(p.pair) as number) * uniform(this.rng, 0.85, 1.15);
      const dec = (PAIR_BY_NAME.get(p.pair) as { decimals: number }).decimals;
      const unit = 10 ** -dec;
      const bid = roundTo(mid * (1 - spread / 2e4), dec);
      let ask = roundTo(mid * (1 + spread / 2e4), dec);
      if (ask <= bid) ask = roundTo(bid + unit, dec);
      const tick: PriceTick = { pair: p.pair, bid, ask, ts: now };
      this.last.set(p.pair, tick);
      ticks.push(tick);
    }
    return ticks;
  }
}
