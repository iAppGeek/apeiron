import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TraderSelector } from './TraderSelector';

const traders = [
  { traderId: 'T1', traderName: 'Alice Marlowe' },
  { traderId: 'T2', traderName: 'Ben Okafor' },
  { traderId: 'T3', traderName: 'Chloe Tanaka' },
  { traderId: 'T4', traderName: 'Diego Ramirez' },
  { traderId: 'T5', traderName: 'Elena Voss' },
];

describe('TraderSelector', () => {
  it('offers All traders plus the five traders', () => {
    render(<TraderSelector traders={traders} value="ALL" onChange={vi.fn()} />);
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['All traders', ...traders.map((t) => t.traderName)]);
    expect(screen.getByRole('combobox', { name: /trader/i })).toHaveValue('ALL');
  });

  it('reports the chosen trader id', async () => {
    const onChange = vi.fn();
    render(<TraderSelector traders={traders} value="ALL" onChange={onChange} />);
    await userEvent.selectOptions(screen.getByRole('combobox'), 'T3');
    expect(onChange).toHaveBeenCalledWith('T3');
  });

  it('reflects the selected value', () => {
    render(<TraderSelector traders={traders} value="T2" onChange={vi.fn()} />);
    expect(screen.getByRole('combobox')).toHaveValue('T2');
  });

  it('can be disabled before the server has said welcome', () => {
    render(<TraderSelector traders={[]} value="ALL" disabled onChange={vi.fn()} />);
    expect(screen.getByRole('combobox')).toBeDisabled();
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });
});

describe('TraderSelector switching state', () => {
  it('shows switching while the picked trader is not confirmed, and hides it after', () => {
    const { rerender } = render(<TraderSelector traders={traders} value="ALL" switching onChange={vi.fn()} />);
    expect(screen.getByText(/switching/)).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveValue('ALL');
    rerender(<TraderSelector traders={traders} value="T2" onChange={vi.fn()} />);
    expect(screen.queryByText(/switching/)).toBeNull();
  });
});
