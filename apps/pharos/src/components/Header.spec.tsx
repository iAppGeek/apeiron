import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Header } from './Header';

describe('Header', () => {
  it('shows the app name and subtitle', () => {
    render(<Header preset={null} onPresetChange={vi.fn()} traders={[]} traderId="ALL" codec="json" ready onTraderChange={vi.fn()} onCodecChange={vi.fn()} />);
    expect(screen.getByText('Apeiron')).toBeInTheDocument();
    expect(screen.getByText('Infinity Blotter')).toBeInTheDocument();
  });

  it('wires the trader selector and the dev menu', async () => {
    const onTraderChange = vi.fn();
    const onCodecChange = vi.fn();
    render(
      <Header
        preset={null}
        onPresetChange={vi.fn()}
        traders={[{ traderId: 'T1', traderName: 'Alice' }]}
        traderId="ALL"
        codec="json"
        ready
        onTraderChange={onTraderChange}
        onCodecChange={onCodecChange}
      />,
    );
    await userEvent.selectOptions(screen.getByRole('combobox'), 'T1');
    expect(onTraderChange).toHaveBeenCalledWith('T1');
    await userEvent.click(screen.getByRole('button', { name: 'Dev' }));
    await userEvent.click(screen.getByRole('radio', { name: 'MessagePack' }));
    expect(onCodecChange).toHaveBeenCalledWith('msgpack');
  });

  it('passes the load preset to the dev menu and sends changes', async () => {
    const onPresetChange = vi.fn();
    render(
      <Header
        preset="medium"
        onPresetChange={onPresetChange}
        traders={[]}
        traderId="ALL"
        codec="json"
        ready
        onTraderChange={vi.fn()}
        onCodecChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Dev' }));
    expect(screen.getByRole('radio', { name: 'Medium' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'Stress' }));
    expect(onPresetChange).toHaveBeenCalledWith('stress');
  });

  it('disables the controls until ready', () => {
    render(<Header preset={null} onPresetChange={vi.fn()} traders={[]} traderId="ALL" codec="json" ready={false} onTraderChange={vi.fn()} onCodecChange={vi.fn()} />);
    expect(screen.getByRole('combobox')).toBeDisabled();
  });
});
