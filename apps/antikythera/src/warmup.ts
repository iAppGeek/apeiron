import { readFileSync } from 'node:fs';
import { TRADERS, ssrmRequestSchema, type SsrmRequest } from '@apeiron/logos';
import { z } from 'zod';
import type { QueryEngine } from './query/engine.js';

/** One view to warm: the trader scopes it is built for (`'*'` is everyone) and the request that defines it. */
export type WarmEntry = { traders: string[] | '*'; req: SsrmRequest };

/** Blocks 0 to 4 of 100 rows: what a client asks for when it opens a view. */
export const WARM_BLOCKS = 5;
export const WARM_BLOCK_ROWS = 100;

const request = (overrides: Partial<SsrmRequest>): SsrmRequest => ({
  startRow: 0,
  endRow: WARM_BLOCK_ROWS,
  rowGroupCols: [],
  valueCols: [],
  groupKeys: [],
  sortModel: [],
  filterModel: null,
  ...overrides,
});

/**
 * The views clients open first: `createdAt desc` (the default sort) for everyone and for each trader on its own,
 * and everyone grouped by status. Until entitlements exist (phase 1.6) a "trader set" is a single trader or all.
 */
export function defaultWarmViews(): WarmEntry[] {
  return [
    { traders: ['ALL', ...TRADERS.map((t) => t.traderId)], req: request({ sortModel: [{ colId: 'createdAt', sort: 'desc' }] }) },
    {
      traders: ['ALL'],
      req: request({ rowGroupCols: [{ id: 'status' }], valueCols: [{ id: 'notionalUsd', aggFunc: 'sum' }] }),
    },
  ];
}

const fileSchema = z.array(z.object({ traders: z.union([z.array(z.string().min(1)).min(1), z.literal('*')]), req: ssrmRequestSchema }));

/** `default` for {@link defaultWarmViews}, otherwise the path of a JSON file of `{traders, req}` entries. */
export function loadWarmViews(spec: string, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): WarmEntry[] {
  if (spec === 'default') return defaultWarmViews();
  let json: unknown;
  try {
    json = JSON.parse(read(spec));
  } catch (error) {
    throw new Error(`WARM_VIEWS: cannot read ${spec}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`WARM_VIEWS: ${spec} is not a list of {traders, req}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}

export type WarmReport = { views: number; requests: number; failures: number; ms: number };

export type WarmOptions = {
  /** Gives the event loop a turn between views (default: a macrotask). */
  yieldToLoop?: () => Promise<void>;
  log?: (fields: Record<string, unknown>, message: string) => void;
};

const defaultYield = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Builds each view, then runs `rounds` synthetic passes of `getRows` (blocks 0 to 4) over it, so that the first real
 * client finds sorts, ranks and the JIT already warm: "ready" then means fast, not just loaded.
 */
export async function warmUp(engine: QueryEngine, entries: readonly WarmEntry[], rounds: number, options: WarmOptions = {}): Promise<WarmReport> {
  const started = performance.now();
  const turn = options.yieldToLoop ?? defaultYield;
  let views = 0;
  let requests = 0;
  let failures = 0;
  for (const entry of entries) {
    for (const trader of entry.traders === '*' ? ['ALL'] : entry.traders) {
      views++;
      for (let round = 0; round < Math.max(1, rounds); round++) {
        for (let block = 0; block < WARM_BLOCKS; block++) {
          const result = engine.getRows(trader, { ...entry.req, startRow: block * WARM_BLOCK_ROWS, endRow: (block + 1) * WARM_BLOCK_ROWS });
          requests++;
          if (!result.ok) {
            failures++;
            if (failures === 1) options.log?.({ trader, code: result.code, message: result.message }, 'warm-up request failed');
          }
        }
      }
      await turn();
    }
  }
  return { views, requests, failures, ms: Math.round(performance.now() - started) };
}
