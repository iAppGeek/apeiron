import { sampleOrders, type Order } from '@apeiron/logos';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AmendDialog, toLocalInput } from './AmendDialog';

const NOW = 1_800_000_000_000;

const order = (over: Partial<Order> = {}): Order => ({
  ...(sampleOrders(1)[0] as Order),
  orderId: 'ALG00000042',
  currencyPair: 'EURUSD',
  side: 'BUY',
  status: 'LIVE',
  orderQty: 1_000_000,
  filledQty: 100_000,
  remainingQty: 900_000,
  notionalUsd: 1_080_000,
  limitPrice: null,
  urgency: 'MEDIUM',
  startTime: NOW - 3_600_000,
  endTime: NOW + 3_600_000,
  ...over,
});

const setup = (over: Partial<Order> = {}): { onSubmit: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn> } => {
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  render(<AmendDialog order={order(over)} now={() => NOW} onSubmit={onSubmit} onClose={onClose} />);
  return { onSubmit, onClose };
};

describe('AmendDialog', () => {
  it('is a modal dialog showing the order and its current values', () => {
    setup({ limitPrice: 1.08 });
    expect(screen.getByRole('dialog', { name: 'Amend ALG00000042' })).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByTestId('amend-limit')).toHaveValue('1.08');
    expect(screen.getByTestId('amend-qty')).toHaveValue('1000000');
    expect(screen.getByTestId('amend-urgency')).toHaveValue('MEDIUM');
    expect(screen.getByTestId('amend-end')).toHaveValue(toLocalInput(NOW + 3_600_000));
    expect(screen.getByText(/BUY EURUSD, LIVE/)).toBeInTheDocument();
  });

  it('sends only what changed', async () => {
    const { onSubmit } = setup();
    await userEvent.clear(screen.getByTestId('amend-qty'));
    await userEvent.type(screen.getByTestId('amend-qty'), '2000000');
    await userEvent.type(screen.getByTestId('amend-limit'), '1.0850');
    await userEvent.selectOptions(screen.getByTestId('amend-urgency'), 'HIGH');
    await userEvent.click(screen.getByTestId('amend-submit'));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ orderQty: 2_000_000, limitPrice: 1.085, urgency: 'HIGH' });
  });

  it('sends a new end time as milliseconds, and leaves an untouched one out', async () => {
    const { onSubmit } = setup();
    fireEvent.change(screen.getByTestId('amend-end'), { target: { value: toLocalInput(NOW + 7_200_000) } });
    await userEvent.click(screen.getByTestId('amend-submit'));
    expect(onSubmit).toHaveBeenCalledWith({ endTime: new Date(toLocalInput(NOW + 7_200_000)).getTime() });
  });

  it('clears the limit price when the field is emptied', async () => {
    const { onSubmit } = setup({ limitPrice: 1.08 });
    await userEvent.clear(screen.getByTestId('amend-limit'));
    await userEvent.click(screen.getByTestId('amend-submit'));
    expect(onSubmit).toHaveBeenCalledWith({ limitPrice: null });
  });

  it('warns with the server`s own words and sends nothing when a rule is broken', async () => {
    const { onSubmit } = setup();
    await userEvent.clear(screen.getByTestId('amend-qty'));
    await userEvent.type(screen.getByTestId('amend-qty'), '50000');
    await userEvent.click(screen.getByTestId('amend-submit'));
    expect(screen.getByRole('alert')).toHaveTextContent('Quantity must be a whole number above the filled quantity (100000)');
    await userEvent.clear(screen.getByTestId('amend-qty'));
    await userEvent.type(screen.getByTestId('amend-qty'), '1000000');
    await userEvent.type(screen.getByTestId('amend-limit'), '1.123456789');
    await userEvent.click(screen.getByTestId('amend-submit'));
    expect(screen.getByRole('alert')).toHaveTextContent('Limit price must be positive with at most 5 decimals');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('says there is nothing to change, and rejects text where a number is needed', async () => {
    const { onSubmit } = setup();
    await userEvent.click(screen.getByTestId('amend-submit'));
    expect(screen.getByRole('alert')).toHaveTextContent('Nothing to change');
    await userEvent.type(screen.getByTestId('amend-limit'), 'abc');
    await userEvent.click(screen.getByTestId('amend-submit'));
    expect(screen.getByRole('alert')).toHaveTextContent('Limit price must be a number');
    await userEvent.clear(screen.getByTestId('amend-limit'));
    await userEvent.clear(screen.getByTestId('amend-qty'));
    await userEvent.click(screen.getByTestId('amend-submit'));
    expect(screen.getByRole('alert')).toHaveTextContent('Quantity must be a number');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('rejects an end time in the past', async () => {
    const { onSubmit } = setup();
    fireEvent.change(screen.getByTestId('amend-end'), { target: { value: toLocalInput(NOW - 60_000) } });
    await userEvent.click(screen.getByTestId('amend-submit'));
    expect(screen.getByRole('alert')).toHaveTextContent('End time must be after now and the start time');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('closes on Cancel and on Escape', async () => {
    const { onClose } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.type(screen.getByTestId('amend-qty'), '{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('toLocalInput', () => {
  it('formats to the minute in the local zone', () => {
    const d = new Date(2026, 9, 13, 8, 5, 59);
    expect(toLocalInput(d.getTime())).toBe('2026-10-13T08:05');
  });
});
