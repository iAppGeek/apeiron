import { z } from 'zod';

const intWithUnderscores = (fallback: string): z.ZodType<number> =>
  z
    .string()
    .default(fallback)
    .transform((s) => Number(s.replaceAll('_', '')))
    .pipe(z.number().int().positive());

const envSchema = z.object({
  MONGO_URL: z.url({ protocol: /^mongodb(\+srv)?$/ }),
  MONGO_DB: z.string().min(1).default('blotter'),
  SEED_ROWS: intWithUnderscores('1000000'),
  SEED: intWithUnderscores('42'),
  /** Optional ISO timestamp pinning "now" so the dataset is fully reproducible. */
  SEED_NOW: z
    .string()
    .optional()
    .transform((s, ctx): number | undefined => {
      if (s === undefined || s === '') return undefined;
      const ms = Date.parse(s);
      if (Number.isNaN(ms)) {
        ctx.addIssue({ code: 'custom', message: 'SEED_NOW must be an ISO date-time' });
        return undefined;
      }
      return ms;
    }),
  BATCH_SIZE: intWithUnderscores('10000'),
});

export type GaiaConfig = {
  mongoUrl: string;
  mongoDb: string;
  rows: number;
  seed: number;
  /** Epoch ms, or undefined to use the current time. */
  now: number | undefined;
  batchSize: number;
};

export function loadConfig(env: Record<string, string | undefined>): GaiaConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${detail}`);
  }
  const e = parsed.data;
  return {
    mongoUrl: e.MONGO_URL,
    mongoDb: e.MONGO_DB,
    rows: e.SEED_ROWS,
    seed: e.SEED,
    now: e.SEED_NOW,
    batchSize: e.BATCH_SIZE,
  };
}
