import { z } from 'zod';

const posInt = (fallback: string): z.ZodType<number> =>
  z
    .string()
    .default(fallback)
    .transform((s) => Number(s.replaceAll('_', '')))
    .pipe(z.number().int().positive());

const envSchema = z.object({
  NATS_URL: z.url({ protocol: /^nats$/ }),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  /** Seeds the random walk; unset uses the clock. */
  HELIOS_SEED: z
    .string()
    .optional()
    .transform((s): number | undefined => (s === undefined || s === '' ? undefined : Number(s))),
  /** Port of the internal `/health` and `/metrics` endpoints. */
  HEALTH_PORT: posInt('4300').pipe(z.number().max(65535)),
  /** How long to ask the order service for reference levels when the stream has no last price. */
  REF_MIDS_WAIT_MS: posInt('10000'),
});

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export type HeliosConfig = {
  natsUrl: string;
  logLevel: LogLevel;
  seed: number | undefined;
  healthPort: number;
  refMidsWaitMs: number;
};

export function loadConfig(env: Record<string, string | undefined>): HeliosConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${detail}`);
  }
  const e = parsed.data;
  if (e.HELIOS_SEED !== undefined && !Number.isFinite(e.HELIOS_SEED)) {
    throw new Error('Invalid configuration: HELIOS_SEED must be a number');
  }
  return { natsUrl: e.NATS_URL, logLevel: e.LOG_LEVEL, seed: e.HELIOS_SEED, healthPort: e.HEALTH_PORT, refMidsWaitMs: e.REF_MIDS_WAIT_MS };
}
