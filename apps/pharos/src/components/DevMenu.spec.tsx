import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DevMenu } from './DevMenu';

describe('DevMenu', () => {
  it('is closed until the Dev button is pressed', async () => {
    render(<DevMenu preset={null} onPresetChange={vi.fn()} codec="json" onCodecChange={vi.fn()} />);
    expect(screen.queryByRole('radio')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Dev' }));
    expect(screen.getByRole('radio', { name: 'JSON' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'MessagePack' })).not.toBeChecked();
  });

  it('switches the codec', async () => {
    const onCodecChange = vi.fn();
    render(<DevMenu preset={null} onPresetChange={vi.fn()} codec="json" onCodecChange={onCodecChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Dev' }));
    await userEvent.click(screen.getByRole('radio', { name: 'MessagePack' }));
    expect(onCodecChange).toHaveBeenCalledWith('msgpack');
  });

  it('closes on Escape and on an outside click', async () => {
    render(
      <div>
        <DevMenu preset={null} onPresetChange={vi.fn()} codec="msgpack" onCodecChange={vi.fn()} />
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
    render(<DevMenu preset={null} onPresetChange={vi.fn()} codec="json" disabled onCodecChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Dev' }));
    expect(screen.getByRole('radio', { name: 'JSON' })).toBeDisabled();
  });

  it('offers the Medium and Stress presets and shows the active one', async () => {
    render(<DevMenu codec="json" preset="stress" onCodecChange={vi.fn()} onPresetChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Dev' }));
    expect(screen.getByRole('radio', { name: 'Stress' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Medium' })).not.toBeChecked();
    expect(screen.getByText(/active: stress/)).toBeInTheDocument();
  });

  it('shows no active preset until one has been set', async () => {
    render(<DevMenu codec="json" preset={null} onCodecChange={vi.fn()} onPresetChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Dev' }));
    expect(screen.getByRole('radio', { name: 'Medium' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Stress' })).not.toBeChecked();
    expect(screen.queryByText(/active:/)).toBeNull();
  });

  it('sends the chosen preset', async () => {
    const onPresetChange = vi.fn();
    render(<DevMenu codec="json" preset="medium" onCodecChange={vi.fn()} onPresetChange={onPresetChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Dev' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Stress' }));
    expect(onPresetChange).toHaveBeenCalledWith('stress');
  });

  it('disables the presets while a change is pending or the server is not ready', async () => {
    const { rerender } = render(<DevMenu codec="json" preset="medium" presetPending onCodecChange={vi.fn()} onPresetChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Dev' }));
    expect(screen.getByRole('radio', { name: 'Stress' })).toBeDisabled();
    rerender(<DevMenu codec="json" preset="medium" disabled onCodecChange={vi.fn()} onPresetChange={vi.fn()} />);
    expect(screen.getByRole('radio', { name: 'Stress' })).toBeDisabled();
  });
});
