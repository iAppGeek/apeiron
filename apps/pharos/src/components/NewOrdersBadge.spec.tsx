import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { NewOrdersBadge } from './NewOrdersBadge';

describe('NewOrdersBadge', () => {
  it('renders nothing when there are no new orders', () => {
    const { container } = render(<NewOrdersBadge count={0} onClick={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the count with the right plural, and an arrow', () => {
    const { rerender } = render(<NewOrdersBadge count={1} onClick={vi.fn()} />);
    expect(screen.getByRole('button')).toHaveTextContent('1 new order ↑');
    rerender(<NewOrdersBadge count={1234} onClick={vi.fn()} />);
    expect(screen.getByRole('button')).toHaveTextContent('1,234 new orders ↑');
  });

  it('calls onClick when pressed', async () => {
    const onClick = vi.fn();
    render(<NewOrdersBadge count={3} onClick={onClick} />);
    await userEvent.click(screen.getByTestId('new-orders-badge'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
