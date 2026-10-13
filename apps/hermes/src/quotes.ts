import { PAIR_BY_NAME, type CurrencyPair, type PriceTick } from '@apeiron/logos';

/** What the simulator needs to price a fill or an order: the market now. */
export type Quotes = {
  mid(pair: CurrencyPair): number;
  quote(pair: CurrencyPair): PriceTick | undefined;
};

/**
 * The latest quote of each pair, as the price feed published it. hermes does not make prices: it follows
 * `prices.*` and uses the book for fill prices and for the market snapshot of an order that completes. A pair with
 * no quote yet answers with its reference level.
 */
export class QuoteBook implements Quotes {
  private readonly latest = new Map<CurrencyPair, PriceTick>();

  /** Records a tick. One older than the quote already held (a replayed last value) is ignored. */
  update(tick: PriceTick): void {
    const held = this.latest.get(tick.pair);
    if (held === undefined || held.ts <= tick.ts) this.latest.set(tick.pair, tick);
  }

  quote(pair: CurrencyPair): PriceTick | undefined {
    return this.latest.get(pair);
  }

  mid(pair: CurrencyPair): number {
    const tick = this.latest.get(pair);
    return tick === undefined ? (PAIR_BY_NAME.get(pair) as { mid: number }).mid : (tick.bid + tick.ask) / 2;
  }

  /** How many pairs have a quote. */
  get size(): number {
    return this.latest.size;
  }

  /** The pairs that have no quote yet. */
  missing(): CurrencyPair[] {
    return [...PAIR_BY_NAME.keys()].filter((pair) => !this.latest.has(pair));
  }
}
