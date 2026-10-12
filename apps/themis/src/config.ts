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
  NATS_URL: z.url({ protocol: /^nats$/ }),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  /** Port of the internal `/health`, `/metrics` and `/debug` endpoints. */
  HEALTH_PORT: posInt('4200').pipe(z.number().max(65535)),
  /** A group commit waits at most this long for more changes. */
  GROUP_COMMIT_MS: posInt('20'),
  /** ...or until this many changes are waiting. */
  GROUP_COMMIT_MAX: posInt('500'),
  /** How long a command waits for the venue's report (used from phase 1.5c). */
  VENUE_TIMEOUT_MS: posInt('5000'),
  /** At startup, orders updated this recently are checked against the projection. */
  RECONCILE_WINDOW_MIN: posInt('15'),
  /** `1` rebuilds the projection even if it looks complete. */
  REBUILD_PROJECTION: z.enum(['0', '1']).default('0'),
});

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export type ThemisConfig = {
  mongoUrl: string;
  mongoDb: string;
  natsUrl: string;
  logLevel: LogLevel;
  healthPort: number;
  groupCommitMs: number;
  groupCommitMax: number;
  venueTimeoutMs: number;
  reconcileWindowMin: number;
  rebuildProjection: boolean;
};

export function loadConfig(env: Record<string, string | undefined>): ThemisConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${detail}`);
  }
  const e = parsed.data;
  return {
    mongoUrl: e.MONGO_URL,
    mongoDb: e.MONGO_DB,
    natsUrl: e.NATS_URL,
    logLevel: e.LOG_LEVEL,
    healthPort: e.HEALTH_PORT,
    groupCommitMs: e.GROUP_COMMIT_MS,
    groupCommitMax: e.GROUP_COMMIT_MAX,
    venueTimeoutMs: e.VENUE_TIMEOUT_MS,
    reconcileWindowMin: e.RECONCILE_WINDOW_MIN,
    rebuildProjection: e.REBUILD_PROJECTION === '1',
  };
}
