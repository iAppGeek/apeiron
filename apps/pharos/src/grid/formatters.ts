import { PAIR_BY_NAME, priceDecimals, type ColumnMeta, type CurrencyPair } from '@apeiron/logos';

/** Price decimals on rows where the pair is unknown, such as group rows not grouped by pair. */
export const FALLBACK_PRICE_DECIMALS = 5;

const numberFormats = new Map<number, Intl.NumberFormat>();

function numberFormat(decimals: number): Intl.NumberFormat {
  let format = numberFormats.get(decimals);
  if (format === undefined) {
    format = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    numberFormats.set(decimals, format);
  }
  return format;
}

const isBlank = (value: unknown): boolean =>
  value === null || value === undefined || value === '' || (typeof value === 'number' && Number.isNaN(value));

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** Fixed decimals with thousands separators. Null and undefined show as empty. */
export function formatNumber(value: unknown, decimals: number): string {
  if (isBlank(value)) return '';
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? numberFormat(decimals).format(n) : '';
}

/** `YYYY-MM-DD HH:mm:ss` in UTC, the same day boundaries the server filters on. */
export function formatDateTime(value: unknown): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return '';
  const d = new Date(value);
  return (
    `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/** Grouped row counts with thousands separators. */
export function formatCount(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? numberFormat(0).format(value) : '';
}

/**
 * `YYYY-MM-DD`. Value dates are UTC midnight (and group keys are already `YYYY-MM-DD` strings), so the
 * UTC calendar day is used to keep the date stable in every time zone.
 */
export function formatDate(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value !== 'number' || Number.isNaN(value)) return '';
  const d = new Date(value);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Decimals for a price cell: the row's pair decimals, or 5 when the row has no known pair. */
export function decimalsForRow(row: unknown): number {
  const pair = typeof row === 'object' && row !== null ? (row as { currencyPair?: unknown }).currencyPair : undefined;
  if (typeof pair === 'string' && PAIR_BY_NAME.has(pair as CurrencyPair)) return priceDecimals(pair as CurrencyPair);
  return FALLBACK_PRICE_DECIMALS;
}

/** The text shown for `value` in a column, given the whole row (price columns need its pair). */
export function formatCell(meta: ColumnMeta, value: unknown, row: unknown): string {
  switch (meta.type) {
    case 'number':
      return formatNumber(value, meta.pairDecimals === true ? decimalsForRow(row) : (meta.decimals ?? 0));
    case 'datetime':
      return formatDateTime(value);
    case 'date':
      return formatDate(value);
    case 'string':
    case 'enum':
      return isBlank(value) ? '' : String(value);
  }
}
