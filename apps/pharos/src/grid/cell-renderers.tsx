import type { CustomCellRendererProps } from 'ag-grid-react';
import type { ReactElement } from 'react';
import { formatCount } from './formatters';

const STATUS_CLASS: Record<string, string> = {
  LIVE: 'chip-live',
  PENDING_START: 'chip-pending',
  PAUSED: 'chip-paused',
  FILLED: 'chip-filled',
  CANCELLED: 'chip-cancelled',
};

/** Colour-coded status chip. Unknown values render as plain text. */
export function StatusChip({ value }: CustomCellRendererProps): ReactElement | null {
  if (typeof value !== 'string' || value === '') return null;
  const cls = STATUS_CLASS[value];
  if (cls === undefined) return <span>{value}</span>;
  return <span className={`chip ${cls}`}>{value}</span>;
}

/** Cell class for the side column: green for BUY, red for SELL. */
export function sideCellClass(params: { value?: unknown }): string | undefined {
  if (params.value === 'BUY') return 'side-buy';
  if (params.value === 'SELL') return 'side-sell';
  return undefined;
}

/** Group row label: the key, then the server's child count with thousands separators. */
export function GroupLabel({ value, data }: CustomCellRendererProps): ReactElement {
  const count = typeof data === 'object' && data !== null ? (data as { childCount?: unknown }).childCount : undefined;
  return (
    <span>
      {String(value ?? '')}
      {typeof count === 'number' && <span className="group-count"> ({formatCount(count)})</span>}
    </span>
  );
}
