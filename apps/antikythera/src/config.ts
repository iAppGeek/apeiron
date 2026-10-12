import { z } from 'zod';

const posInt = (fallback: string): z.ZodType<number> =>
  z
    .string()
    .default(fallback)
    .transform((s) => Number(s.replaceAll('_', '')))
    .pipe(z.number().int().positive());

const envSchema = z.object({
  PORT: posInt('4000').pipe(z.number().max(65535)),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  NATS_URL: z.url({ protocol: /^nats$/ }),
  /** At startup, how long to wait for a price for every pair before going on without the missing ones. */
  PRICE_WAIT_MS: posInt('10000'),
  /** Caught up with the order-state bucket once an entry has at most this many entries pending behind it. */
  CATCHUP_MAX_PENDING: posInt('100'),
  FLUSH_MS: posInt('50'),
  MAX_TRACKED_BLOCKS: posInt('100'),
  LOAD_PRESET: z.enum(['medium', 'stress']).default('medium'),
  /** Row capacity the store reserves up front (virtual memory only; untouched pages are not resident). */
  STORE_CAPACITY: posInt('1500000'),
  VIEW_CACHE_MAX_VIEWS: posInt('64'),
  VIEW_CACHE_MAX_MB: posInt('384'),
  /** Largest `endRow - startRow` a client may request. */
  MAX_BLOCK_ROWS: posInt('5000'),
  /** Most ms one flush spends patching views; views not reached carry their changes into the next tick. */
  FLUSH_BUDGET_MS: posInt('40'),
  /** `default`, or the path of a JSON file of `{traders, req}` entries: the views built before the blotter is ready. */
  WARM_VIEWS: z.string().min(1).default('default'),
  /** Synthetic passes of blocks 0 to 4 over each warm view. */
  WARM_ROUNDS: posInt('3'),
  /** After SIGTERM, how long to say "not ready" before the sockets are closed with code 1012. */
  DRAIN_MS: posInt('2000'),
  /** A client silent this long (no frame, no pong) is terminated. */
  HEARTBEAT_TIMEOUT_MS: posInt('15000'),
});

export type AntikytheraConfig = {
  port: number;
  host: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  natsUrl: string;
  priceWaitMs: number;
  catchupMaxPending: number;
  flushMs: number;
  maxTrackedBlocks: number;
  loadPreset: 'medium' | 'stress';
  storeCapacity: number;
  viewCacheMaxViews: number;
  viewCacheMaxBytes: number;
  maxBlockRows: number;
  flushBudgetMs: number;
  heartbeatTimeoutMs: number;
  warmViews: string;
  warmRounds: number;
  drainMs: number;
};

export function loadConfig(env: Record<string, string | undefined>): AntikytheraConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${detail}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    natsUrl: e.NATS_URL,
    priceWaitMs: e.PRICE_WAIT_MS,
    catchupMaxPending: e.CATCHUP_MAX_PENDING,
    flushMs: e.FLUSH_MS,
    maxTrackedBlocks: e.MAX_TRACKED_BLOCKS,
    loadPreset: e.LOAD_PRESET,
    storeCapacity: e.STORE_CAPACITY,
    viewCacheMaxViews: e.VIEW_CACHE_MAX_VIEWS,
    viewCacheMaxBytes: e.VIEW_CACHE_MAX_MB * 1024 * 1024,
    maxBlockRows: e.MAX_BLOCK_ROWS,
    flushBudgetMs: e.FLUSH_BUDGET_MS,
    heartbeatTimeoutMs: e.HEARTBEAT_TIMEOUT_MS,
    warmViews: e.WARM_VIEWS,
    warmRounds: e.WARM_ROUNDS,
    drainMs: e.DRAIN_MS,
  };
}
