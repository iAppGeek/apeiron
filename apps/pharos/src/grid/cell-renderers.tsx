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

/** What the grid's `context` offers cell renderers: whether an order has a command in flight. */
export type BlotterContext = { isPending: (orderId: string) => boolean };

function isPending(context: unknown, data: unknown): boolean {
  if (typeof context !== 'object' || context === null || typeof data !== 'object' || data === null) return false;
  const { isPending: check } = context as Partial<BlotterContext>;
  const { orderId } = data as { orderId?: unknown };
  return typeof check === 'function' && typeof orderId === 'string' && check(orderId);
}

/**
 * Colour-coded status chip. Unknown values render as plain text. While a command on the order is in flight
 * the chip is dimmed and shows a small spinner (`aria-busy`), until the server acks or refuses it.
 */
export function StatusChip({ value, data, context }: CustomCellRendererProps): ReactElement | null {
  if (typeof value !== 'string' || value === '') return null;
  const cls = STATUS_CLASS[value];
  if (cls === undefined) return <span>{value}</span>;
  const busy = isPending(context, data);
  return (
    <span className={`chip ${cls}${busy ? ' chip-busy' : ''}`} aria-busy={busy ? 'true' : undefined}>
      {value}
      {busy && <span className="chip-spinner" role="presentation" data-testid="command-pending" />}
    </span>
  );
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
