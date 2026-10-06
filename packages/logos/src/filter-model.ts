import { z } from 'zod';

/** Error code the server returns for any filter shape outside Appendix B. */
export const UNSUPPORTED_FILTER = 'UNSUPPORTED_FILTER';

export const TEXT_FILTER_TYPES = [
  'contains',
  'notContains',
  'equals',
  'notEqual',
  'startsWith',
  'endsWith',
  'blank',
  'notBlank',
] as const;
export type TextFilterType = (typeof TEXT_FILTER_TYPES)[number];

export const NUMBER_FILTER_TYPES = [
  'equals',
  'notEqual',
  'lessThan',
  'lessThanOrEqual',
  'greaterThan',
  'greaterThanOrEqual',
  'inRange',
  'blank',
  'notBlank',
] as const;
export type NumberFilterType = (typeof NUMBER_FILTER_TYPES)[number];
/** Date filters use the same operator set as number filters. */
export type DateFilterType = NumberFilterType;

export type TextFilter = { filterType: 'text'; type: TextFilterType; filter?: string | null };
export type NumberFilter = {
  filterType: 'number';
  type: NumberFilterType;
  filter?: number | null;
  filterTo?: number | null;
};
/** `dateFrom` / `dateTo` are `'YYYY-MM-DD HH:mm:ss'` (UTC). */
export type DateFilter = {
  filterType: 'date';
  type: DateFilterType;
  dateFrom?: string | null;
  dateTo?: string | null;
};
export type SetFilter = { filterType: 'set'; values: string[] };

export type SimpleFilter = TextFilter | NumberFilter | DateFilter;
export type CombinedFilter = {
  filterType: 'text' | 'number' | 'date';
  operator: 'AND' | 'OR';
  conditions: SimpleFilter[];
};
export type ColumnFilter = SimpleFilter | SetFilter | CombinedFilter;
/** Keyed by column id (the field name). Filters on different columns are ANDed. */
export type FilterModel = Record<string, ColumnFilter>;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?$/;

/** Parses `'YYYY-MM-DD HH:mm:ss'` (time optional) as UTC epoch ms, or NaN when malformed or out of range. */
export function parseFilterDate(text: string): number {
  const m = DATE_RE.exec(text);
  if (m === null) return Number.NaN;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4] ?? '0', m[5] ?? '0', m[6] ?? '0'].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return Number.NaN;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  // Reject rollovers such as 2026-02-31.
  return new Date(ms).getUTCDate() === d ? ms : Number.NaN;
}

const dateString = z.string().refine((s) => !Number.isNaN(parseFilterDate(s)), 'expected YYYY-MM-DD HH:mm:ss');

const textSchema = z
  .object({
    filterType: z.literal('text'),
    type: z.enum(TEXT_FILTER_TYPES),
    filter: z.string().nullish(),
  })
  .refine((f) => f.type === 'blank' || f.type === 'notBlank' || typeof f.filter === 'string', {
    message: 'filter is required',
    path: ['filter'],
  });

const needsBounds = (type: NumberFilterType): boolean => type !== 'blank' && type !== 'notBlank';

const numberSchema = z
  .object({
    filterType: z.literal('number'),
    type: z.enum(NUMBER_FILTER_TYPES),
    filter: z.number().finite().nullish(),
    filterTo: z.number().finite().nullish(),
  })
  .superRefine((f, ctx) => {
    if (needsBounds(f.type) && typeof f.filter !== 'number') {
      ctx.addIssue({ code: 'custom', message: 'filter is required', path: ['filter'] });
    }
    if (f.type === 'inRange' && typeof f.filterTo !== 'number') {
      ctx.addIssue({ code: 'custom', message: 'filterTo is required', path: ['filterTo'] });
    }
  });

const dateSchema = z
  .object({
    filterType: z.literal('date'),
    type: z.enum(NUMBER_FILTER_TYPES),
    dateFrom: dateString.nullish(),
    dateTo: dateString.nullish(),
  })
  .superRefine((f, ctx) => {
    if (needsBounds(f.type) && typeof f.dateFrom !== 'string') {
      ctx.addIssue({ code: 'custom', message: 'dateFrom is required', path: ['dateFrom'] });
    }
    if (f.type === 'inRange' && typeof f.dateTo !== 'string') {
      ctx.addIssue({ code: 'custom', message: 'dateTo is required', path: ['dateTo'] });
    }
  });

const setSchema = z.object({ filterType: z.literal('set'), values: z.array(z.string()) });

const combined = <T extends z.ZodType>(kind: 'text' | 'number' | 'date', condition: T): z.ZodType =>
  z.object({
    filterType: z.literal(kind),
    operator: z.enum(['AND', 'OR']),
    conditions: z.array(condition).min(1),
  });

const columnFilterSchema: z.ZodType<ColumnFilter> = z.union([
  textSchema,
  numberSchema,
  dateSchema,
  setSchema,
  combined('text', textSchema),
  combined('number', numberSchema),
  combined('date', dateSchema),
]) as z.ZodType<ColumnFilter>;

export const filterModelSchema: z.ZodType<FilterModel> = z.record(z.string(), columnFilterSchema);

export type FilterParseResult =
  | { ok: true; value: FilterModel }
  | { ok: false; code: typeof UNSUPPORTED_FILTER; error: string };

/** Validates an AG Grid filter model. `null`/`undefined` mean "no filter". Unknown shapes are `UNSUPPORTED_FILTER`. */
export function parseFilterModel(input: unknown): FilterParseResult {
  if (input === null || input === undefined) return { ok: true, value: {} };
  const result = filterModelSchema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  const error = result.error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.')}: ${i.message}`)
    .join('; ');
  return { ok: false, code: UNSUPPORTED_FILTER, error };
}
