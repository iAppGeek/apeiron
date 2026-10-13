import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { USERS } from '../state/users';
import { UserPicker } from './UserPicker';

describe('UserPicker', () => {
  it('is a modal dialog with a button for every user', () => {
    render(<UserPicker users={USERS} onPick={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Who is looking?' })).toHaveAttribute('aria-modal', 'true');
    expect(screen.getAllByRole('button')).toHaveLength(USERS.length);
  });

  it('reports the user that was clicked', async () => {
    const onPick = vi.fn();
    render(<UserPicker users={USERS} onPick={onPick} />);
    await userEvent.click(screen.getByRole('button', { name: /Ben Okafor/ }));
    expect(onPick).toHaveBeenCalledWith('TRADER2');
  });
});
