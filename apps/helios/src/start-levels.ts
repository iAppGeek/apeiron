import { PAIRS, STREAMS, SUBJECTS, parsePriceTick, type Bus, type CurrencyPair } from '@apeiron/logos';
import { referenceMids } from './price-feed.js';
import type { Logger } from './log.js';

export type LevelSource = 'last-price' | 'ref-mids' | 'reference';
export type StartLevels = { levels: Record<CurrencyPair, number>; sources: Record<CurrencyPair, LevelSource> };

export type StartLevelOptions = {
  /** How long to keep asking the order service for reference levels (default 10 s). */
  refMidsWaitMs?: number;
  /** Timeout of each request (default 1 s). */
  requestTimeoutMs?: number;
  /** Wait between requests (default 500 ms). */
  retryMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const mid = (bid: number, ask: number): number => (bid + ask) / 2;

/**
 * Where the walk starts, pair by pair: the last price on the stream (so a restart carries on from where the market
 * was), else the level the order service reports for its open orders (`ref.mids`, asked for up to `refMidsWaitMs`),
 * else the pair's reference level.
 */
export async function startLevels(bus: Bus, log: Logger, options: StartLevelOptions = {}): Promise<StartLevels> {
  const now = options.now ?? ((): number => Date.now());
  const sleep = options.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const levels = referenceMids();
  const sources = Object.fromEntries(PAIRS.map((p): [CurrencyPair, LevelSource] => [p.pair, 'reference'])) as Record<CurrencyPair, LevelSource>;
  const have = new Set<CurrencyPair>();

  try {
    for (const message of await bus.lastPerSubject(STREAMS.prices, SUBJECTS.pricesWildcard)) {
      const parsed = parsePriceTick(message.payload);
      if (!parsed.ok) continue;
      levels[parsed.value.pair] = mid(parsed.value.bid, parsed.value.ask);
      sources[parsed.value.pair] = 'last-price';
      have.add(parsed.value.pair);
    }
  } catch (error) {
    log.warn({ err: error }, 'could not read the last prices');
  }

  if (have.size < PAIRS.length) {
    const deadline = now() + (options.refMidsWaitMs ?? 10_000);
    for (;;) {
      try {
        const reply = (await bus.request(SUBJECTS.refMids, {}, options.requestTimeoutMs ?? 1_000)) as Partial<Record<CurrencyPair, number>>;
        for (const p of PAIRS) {
          const level = reply[p.pair];
          if (!have.has(p.pair) && typeof level === 'number' && level > 0) {
            levels[p.pair] = level;
            sources[p.pair] = 'ref-mids';
          }
        }
        break;
      } catch (error) {
        if (now() >= deadline) {
          log.warn({ err: error }, 'no reference levels from the order service; using the reference mids');
          break;
        }
        await sleep(options.retryMs ?? 500);
      }
    }
  }
  return { levels, sources };
}
