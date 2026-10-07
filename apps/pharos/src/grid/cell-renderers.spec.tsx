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

  describe('in-progress indicator', () => {
    const renderWith = (context: unknown, data: unknown): void => {
      render(<StatusChip {...({ value: 'LIVE', context, data } as CustomCellRendererProps)} />);
    };

    it('dims the chip and shows a spinner while a command on the order is pending', () => {
      renderWith({ isPending: (id: string) => id === 'ALG1' }, { orderId: 'ALG1' });
      const chip = screen.getByText('LIVE');
      expect(chip).toHaveClass('chip-busy');
      expect(chip).toHaveAttribute('aria-busy', 'true');
      expect(screen.getByTestId('command-pending')).toBeInTheDocument();
    });

    it('is plain for other orders, and without a context or data', () => {
      renderWith({ isPending: () => false }, { orderId: 'ALG2' });
      expect(screen.getByText('LIVE')).not.toHaveClass('chip-busy');
      expect(screen.queryByTestId('command-pending')).toBeNull();
    });

    it.each([
      [undefined, { orderId: 'A' }],
      [{ isPending: () => true }, undefined],
      [{ isPending: () => true }, { orderId: 5 }],
      [{ isPending: 'nope' }, { orderId: 'A' }],
    ])('ignores a malformed context or data (%#)', (context, data) => {
      renderWith(context, data);
      expect(screen.queryByTestId('command-pending')).toBeNull();
    });
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
