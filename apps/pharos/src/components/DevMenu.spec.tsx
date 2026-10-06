import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DevMenu } from './DevMenu';

describe('DevMenu', () => {
  it('is closed until the Dev button is pressed', async () => {
    render(<DevMenu codec="json" onCodecChange={vi.fn()} />);
    expect(screen.queryByRole('radio')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Dev' }));
    expect(screen.getByRole('radio', { name: 'JSON' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'MessagePack' })).not.toBeChecked();
  });

  it('switches the codec', async () => {
    const onCodecChange = vi.fn();
    render(<DevMenu codec="json" onCodecChange={onCodecChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Dev' }));
    await userEvent.click(screen.getByRole('radio', { name: 'MessagePack' }));
    expect(onCodecChange).toHaveBeenCalledWith('msgpack');
  });

  it('closes on Escape and on an outside click', async () => {
    render(
      <div>
        <DevMenu codec="msgpack" onCodecChange={vi.fn()} />
        <button type="button">outside</button>
      </div>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Dev' }));
    expect(screen.getByRole('radio', { name: 'MessagePack' })).toBeChecked();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('radio')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Dev' }));
    await userEvent.click(screen.getByRole('button', { name: 'outside' }));
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('disables the options while the server is not ready', async () => {
    render(<DevMenu codec="json" disabled onCodecChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Dev' }));
    expect(screen.getByRole('radio', { name: 'JSON' })).toBeDisabled();
  });
});
