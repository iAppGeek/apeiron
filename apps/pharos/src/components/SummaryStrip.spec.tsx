import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SummaryStrip, formatUsdShort } from './SummaryStrip';

const summary = {
  byStatus: { PENDING_START: 120, LIVE: 4_500, PAUSED: 12, FILLED: 800_000, CANCELLED: 200_000 },
  liveNotionalUsd: 4_210_000_000,
  totalRows: 1_004_632,
};

describe('formatUsdShort', () => {
  it.each([
    [0, '$0'],
    [950, '$950'],
    [12_345, '$12.3k'],
    [999_999, '$1000k'],
    [4_210_000, '$4.21m'],
    [4_210_000_000, '$4.21bn'],
    [42_100_000_000, '$42.1bn'],
    [421_000_000_000, '$421bn'],
    [1_200_000_000_000, '$1.20tn'],
    [-3_500_000, '-$3.50m'],
  ])('formats %d as %s', (value, expected) => {
    expect(formatUsdShort(value)).toBe(expected);
  });
});

describe('SummaryStrip', () => {
  it('shows a chip per status with its count, and the live notional', () => {
    render(<SummaryStrip summary={summary} />);
    expect(screen.getByTestId('summary-LIVE')).toHaveTextContent('LIVE4,500');
    expect(screen.getByTestId('summary-PENDING_START')).toHaveTextContent('PENDING_START120');
    expect(screen.getByTestId('summary-PAUSED')).toHaveTextContent('PAUSED12');
    expect(screen.getByTestId('summary-FILLED')).toHaveTextContent('FILLED800,000');
    expect(screen.getByTestId('summary-CANCELLED')).toHaveTextContent('CANCELLED200,000');
    expect(screen.getByTestId('summary-notional')).toHaveTextContent('$4.21bn');
  });

  it('colours each chip like the status cell', () => {
    render(<SummaryStrip summary={summary} />);
    expect(screen.getByTestId('summary-LIVE')).toHaveClass('chip-live');
    expect(screen.getByTestId('summary-PENDING_START')).toHaveClass('chip-pending');
    expect(screen.getByTestId('summary-PAUSED')).toHaveClass('chip-paused');
    expect(screen.getByTestId('summary-FILLED')).toHaveClass('chip-filled');
    expect(screen.getByTestId('summary-CANCELLED')).toHaveClass('chip-cancelled');
  });

  it('lists the chips in the order LIVE, PENDING_START, PAUSED, FILLED, CANCELLED', () => {
    render(<SummaryStrip summary={summary} />);
    const ids = screen.getAllByTestId(/^summary-(?!notional)/).map((el) => el.getAttribute('data-testid'));
    expect(ids).toEqual(['summary-LIVE', 'summary-PENDING_START', 'summary-PAUSED', 'summary-FILLED', 'summary-CANCELLED']);
  });

  it('shows dashes before the first summary', () => {
    render(<SummaryStrip summary={null} />);
    expect(screen.getByTestId('summary-LIVE')).toHaveTextContent('LIVE—');
    expect(screen.getByTestId('summary-notional')).toHaveTextContent('—');
  });
});
