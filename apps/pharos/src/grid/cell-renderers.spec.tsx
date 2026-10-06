import type { CustomCellRendererProps } from 'ag-grid-react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GroupLabel, StatusChip, sideCellClass } from './cell-renderers';

const renderChip = (value: unknown): void => {
  render(<StatusChip {...({ value } as CustomCellRendererProps)} />);
};

describe('StatusChip', () => {
  it.each([
    ['LIVE', 'chip-live'],
    ['PENDING_START', 'chip-pending'],
    ['PAUSED', 'chip-paused'],
    ['FILLED', 'chip-filled'],
    ['CANCELLED', 'chip-cancelled'],
  ])('renders %s with %s', (status, cls) => {
    renderChip(status);
    const chip = screen.getByText(status);
    expect(chip).toHaveClass('chip', cls);
  });

  it('renders unknown statuses as plain text', () => {
    renderChip('WEIRD');
    expect(screen.getByText('WEIRD')).not.toHaveClass('chip');
  });

  it('renders nothing for null', () => {
    const { container } = render(<StatusChip {...({ value: null } as CustomCellRendererProps)} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('sideCellClass', () => {
  it('colours BUY and SELL and ignores everything else', () => {
    expect(sideCellClass({ value: 'BUY' })).toBe('side-buy');
    expect(sideCellClass({ value: 'SELL' })).toBe('side-sell');
    expect(sideCellClass({ value: 'x' })).toBeUndefined();
  });
});

describe('GroupLabel', () => {
  it('shows the key and the count with thousands separators', () => {
    render(<GroupLabel {...({ value: 'EURUSD', data: { childCount: 250546 } } as CustomCellRendererProps)} />);
    expect(screen.getByText('EURUSD', { exact: false })).toHaveTextContent('EURUSD (250,546)');
  });

  it('shows just the key when there is no count', () => {
    render(<GroupLabel {...({ value: 'BUY', data: {} } as CustomCellRendererProps)} />);
    expect(screen.getByText('BUY')).toHaveTextContent(/^BUY$/);
  });
});
