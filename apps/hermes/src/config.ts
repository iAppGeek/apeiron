import { z } from 'zod';

const posInt = (fallback: string): z.ZodType<number> =>
  z
    .string()
    .default(fallback)
    .transform((s) => Number(s.replaceAll('_', '')))
    .pipe(z.number().int().positive());

const envSchema = z.object({
  /** Needed only in `events` mode: in `reports` mode the order service owns the database. */
  MONGO_URL: z.url({ protocol: /^mongodb(\+srv)?$/ }).optional(),
  MONGO_DB: z.string().min(1).default('blotter'),
  NATS_URL: z.url({ protocol: /^nats$/ }),
  /** `events`: publish orders.events (default for now). `reports`: submissions and execution reports to the order service. */
  EXEC_MODE: z.enum(['events', 'reports']).default('events'),
  LOAD_PRESET: z.enum(['medium', 'stress']).default('medium'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  /** Seeds the random walk and the lifecycle simulator; unset uses the clock. */
  HERMES_SEED: z
    .string()
    .optional()
    .transform((s): number | undefined => (s === undefined || s === '' ? undefined : Number(s))),
  /** Port of the internal `/health` endpoint. */
  HEALTH_PORT: posInt('4100').pipe(z.number().max(65535)),
  /** How long to wait at startup for a quote for every pair from the price feed. */
  PRICE_WAIT_MS: posInt('10000'),
  /** Lifecycle simulator step length. */
  STEP_MS: posInt('100'),
});

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export type HermesConfig = {
  mongoUrl: string | undefined;
  execMode: 'events' | 'reports';
  mongoDb: string;
  natsUrl: string;
  loadPreset: 'medium' | 'stress';
  logLevel: LogLevel;
  seed: number | undefined;
  healthPort: number;
  stepMs: number;
  priceWaitMs: number;
};

export function loadConfig(env: Record<string, string | undefined>): HermesConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${detail}`);
  }
  const e = parsed.data;
  if (e.HERMES_SEED !== undefined && !Number.isFinite(e.HERMES_SEED)) {
    throw new Error('Invalid configuration: HERMES_SEED must be a number');
  }
  if (e.EXEC_MODE === 'events' && e.MONGO_URL === undefined) throw new Error('Invalid configuration: MONGO_URL: required when EXEC_MODE is events');
  return {
    mongoUrl: e.MONGO_URL,
    execMode: e.EXEC_MODE,
    mongoDb: e.MONGO_DB,
    natsUrl: e.NATS_URL,
    loadPreset: e.LOAD_PRESET,
    logLevel: e.LOG_LEVEL,
    seed: e.HERMES_SEED,
    healthPort: e.HEALTH_PORT,
    stepMs: e.STEP_MS,
    priceWaitMs: e.PRICE_WAIT_MS,
  };
}
