import type { OrderStatus } from '@apeiron/logos';
import type { ReactElement } from 'react';
import type { SummaryStats } from '../state/app-store';

export type SummaryStripProps = {
  summary: SummaryStats | null;
};

const CHIP_CLASS: Record<OrderStatus, string> = {
  LIVE: 'chip-live',
  PENDING_START: 'chip-pending',
  PAUSED: 'chip-paused',
  FILLED: 'chip-filled',
  CANCELLED: 'chip-cancelled',
};

/** The order the chips appear in: active first, then finished. */
const CHIP_ORDER: readonly OrderStatus[] = ['LIVE', 'PENDING_START', 'PAUSED', 'FILLED', 'CANCELLED'];

const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Abbreviated USD: $950, $12.3k, $4.21m, $4.21bn, $1.20tn. */
export function formatUsdShort(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  const units: [number, string][] = [
    [1e12, 'tn'],
    [1e9, 'bn'],
    [1e6, 'm'],
    [1e3, 'k'],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const scaled = abs / size;
      const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
      return `${sign}$${scaled.toFixed(digits)}${suffix}`;
    }
  }
  return `${sign}$${integer.format(abs)}`;
}

/** Slim strip under the header: order counts by status and the live notional, for the selected trader. */
export function SummaryStrip({ summary }: SummaryStripProps): ReactElement {
  return (
    <section className="summary-strip" aria-label="Order summary">
      {CHIP_ORDER.map((status) => (
        <span key={status} className={`chip ${CHIP_CLASS[status]}`} data-testid={`summary-${status}`}>
          {status}
          <span className="summary-count">{summary === null ? '—' : integer.format(summary.byStatus[status])}</span>
        </span>
      ))}
      <span className="summary-notional">
        <span className="status-label">Live notional</span>
        <span className="status-value" data-testid="summary-notional">
          {summary === null ? '—' : formatUsdShort(summary.liveNotionalUsd)}
        </span>
      </span>
    </section>
  );
}
