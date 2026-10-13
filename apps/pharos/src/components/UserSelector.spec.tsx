import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { USERS } from '../state/users';
import { UserSelector } from './UserSelector';

describe('UserSelector', () => {
  it('offers every user by name and shows the current one', () => {
    render(<UserSelector users={USERS} value="TRADER2" onChange={vi.fn()} />);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(USERS.map((u) => u.name));
    expect(screen.getByRole('combobox', { name: /user/i })).toHaveValue('TRADER2');
  });

  it('reports the chosen user id', async () => {
    const onChange = vi.fn();
    render(<UserSelector users={USERS} value="TRADER2" onChange={onChange} />);
    await userEvent.selectOptions(screen.getByRole('combobox'), 'SUPERVISOR');
    expect(onChange).toHaveBeenCalledWith('SUPERVISOR');
  });

  it('can be disabled', () => {
    render(<UserSelector users={USERS} value="TRADER1" disabled onChange={vi.fn()} />);
    expect(screen.getByRole('combobox')).toBeDisabled();
  });
});
