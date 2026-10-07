/** Pure helpers for reading the numbers and dates the grid displays. */

/** "1,234,567.89" to 1234567.89; NaN for an empty cell, a dash, or anything else that is not a number. */
export function parseNumber(text: string): number {
  const cleaned = text.replace(/[,\s]/g, '');
  if (cleaned === '' || !/^-?\d+(\.\d+)?$/.test(cleaned)) return Number.NaN;
  return Number(cleaned);
}

/** "27 new orders" or "1,204 new orders ↑" to the leading count; 0 when the text has none. */
export function parseLeadingCount(text: string): number {
  const match = /^\s*([\d,]+)/.exec(text);
  return match?.[1] === undefined ? 0 : parseNumber(match[1]);
}

/** The count in a group label such as "EURUSD (123,456)"; null when there is none. */
export function parseGroupCount(label: string): number | null {
  const match = /\(([\d,]+)\)\s*$/.exec(label);
  return match?.[1] === undefined ? null : parseNumber(match[1]);
}

/** True when the values never decrease (ascending) or never increase (descending). Non-numbers are skipped. */
export function isMonotonic(values: readonly number[], direction: 'asc' | 'desc'): boolean {
  const numbers = values.filter((v) => !Number.isNaN(v));
  return numbers.every((value, i) => {
    const previous = numbers[i - 1];
    if (previous === undefined) return true;
    return direction === 'asc' ? value >= previous : value <= previous;
  });
}

/** The same check for text, in the server's order: plain code-point comparison of lower-cased strings. */
export function isTextSorted(values: readonly string[], direction: 'asc' | 'desc'): boolean {
  const lower = values.map((v) => v.toLowerCase());
  return lower.every((value, i) => {
    const previous = lower[i - 1];
    if (previous === undefined) return true;
    return direction === 'asc' ? value >= previous : value <= previous;
  });
}
