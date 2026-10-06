import { z } from 'zod';

const posInt = (fallback: string): z.ZodType<number> =>
  z
    .string()
    .default(fallback)
    .transform((s) => Number(s.replaceAll('_', '')))
    .pipe(z.number().int().positive());

const envSchema = z.object({
  MONGO_URL: z.url({ protocol: /^mongodb(\+srv)?$/ }),
  MONGO_DB: z.string().min(1).default('blotter'),
  DB_ADAPTER: z.enum(['mongo']).default('mongo'),
  PORT: posInt('4000').pipe(z.number().max(65535)),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Used from phase 5; optional until then. */
  NATS_URL: z.url({ protocol: /^nats$/ }).optional(),
  FLUSH_MS: posInt('100'),
  WRITE_BEHIND_MS: posInt('500'),
  MAX_TRACKED_BLOCKS: posInt('100'),
  LOAD_PRESET: z.enum(['medium', 'stress']).default('medium'),
  /** Row capacity the store reserves up front (virtual memory only; untouched pages are not resident). */
  STORE_CAPACITY: posInt('1500000'),
  VIEW_CACHE_MAX_VIEWS: posInt('64'),
  VIEW_CACHE_MAX_MB: posInt('384'),
  /** Largest `endRow - startRow` a client may request. */
  MAX_BLOCK_ROWS: posInt('5000'),
});

export type AntikytheraConfig = {
  mongoUrl: string;
  mongoDb: string;
  dbAdapter: 'mongo';
  port: number;
  host: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  natsUrl: string | undefined;
  flushMs: number;
  writeBehindMs: number;
  maxTrackedBlocks: number;
  loadPreset: 'medium' | 'stress';
  storeCapacity: number;
  viewCacheMaxViews: number;
  viewCacheMaxBytes: number;
  maxBlockRows: number;
};

export function loadConfig(env: Record<string, string | undefined>): AntikytheraConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${detail}`);
  }
  const e = parsed.data;
  return {
    mongoUrl: e.MONGO_URL,
    mongoDb: e.MONGO_DB,
    dbAdapter: e.DB_ADAPTER,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    natsUrl: e.NATS_URL,
    flushMs: e.FLUSH_MS,
    writeBehindMs: e.WRITE_BEHIND_MS,
    maxTrackedBlocks: e.MAX_TRACKED_BLOCKS,
    loadPreset: e.LOAD_PRESET,
    storeCapacity: e.STORE_CAPACITY,
    viewCacheMaxViews: e.VIEW_CACHE_MAX_VIEWS,
    viewCacheMaxBytes: e.VIEW_CACHE_MAX_MB * 1024 * 1024,
    maxBlockRows: e.MAX_BLOCK_ROWS,
  };
}
