import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toasts } from './Toasts';

afterEach(() => {
  vi.useRealTimers();
});

describe('Toasts', () => {
  it('renders each toast and dismisses on click', async () => {
    const onDismiss = vi.fn();
    render(
      <Toasts
        toasts={[
          { id: 1, kind: 'error', text: 'Boom' },
          { id: 2, kind: 'info', text: 'FYI' },
        ]}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Boom');
    expect(screen.getByRole('status')).toHaveTextContent('FYI');
    await userEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[0] as HTMLElement);
    expect(onDismiss).toHaveBeenCalledWith(1);
  });

  it('dismisses a toast after its lifetime', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toasts toasts={[{ id: 5, kind: 'error', text: 'x' }]} onDismiss={onDismiss} lifetimeMs={1000} />);
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledWith(5);
  });
});
