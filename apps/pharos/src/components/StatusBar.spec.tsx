import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBar, type StatusBarProps } from './StatusBar';

const base: StatusBarProps = {
  status: 'connected',
  reconnectAttempt: 0,
  codec: 'json',
  rowCount: 1_000_000,
  grouped: false,
  rttMs: 3.4,
  fps: 60,
  msgsInPerSec: 12.34,
  msgsOutPerSec: 2,
  server: null,
};

const text = (id: string): string | null => screen.getByTestId(id).textContent;

describe('StatusBar', () => {
  it('shows connection, codec, rows, rtt, fps and message rates', () => {
    render(<StatusBar {...base} />);
    expect(text('status-connection')).toBe('Connected');
    expect(text('status-codec')).toBe('json');
    expect(text('status-rows')).toBe('1,000,000');
    expect(text('status-rtt')).toBe('3 ms');
    expect(text('status-fps')).toBe('60');
    expect(text('status-in')).toBe('12.3 msg/s');
    expect(text('status-out')).toBe('2.0 msg/s');
  });

  it('says Groups instead of Rows when the count is of root groups', () => {
    const { rerender } = render(<StatusBar {...base} rowCount={20} grouped />);
    expect(screen.getByText('Groups')).toBeInTheDocument();
    expect(screen.queryByText('Rows')).toBeNull();
    expect(text('status-rows')).toBe('20');
    rerender(<StatusBar {...base} />);
    expect(screen.getByText('Rows')).toBeInTheDocument();
    expect(screen.queryByText('Groups')).toBeNull();
  });

  it('shows dashes for unknown values and the server placeholders', () => {
    render(<StatusBar {...base} rowCount={null} rttMs={null} fps={null} />);
    expect(text('status-rows')).toBe('—');
    expect(text('status-rtt')).toBe('—');
    expect(text('status-fps')).toBe('—');
    expect(text('status-cpu')).toBe('—');
    expect(text('status-rss')).toBe('—');
  });

  it('shows server cpu and rss once a summary has arrived', () => {
    render(<StatusBar {...base} server={{ cpu: 12.34, rssMb: 801.6, elLagMs: 1 }} />);
    expect(text('status-cpu')).toBe('12.3%');
    expect(text('status-rss')).toBe('802 MB');
  });

  it('shows the reconnect attempt and the msgpack codec', () => {
    render(<StatusBar {...base} status="reconnecting" reconnectAttempt={4} codec="msgpack" />);
    expect(text('status-connection')).toBe('Reconnecting (#4)');
    expect(text('status-codec')).toBe('msgpack');
  });

  it.each([
    ['connecting', 'Connecting'],
    ['closed', 'Disconnected'],
  ] as const)('labels %s', (status, label) => {
    render(<StatusBar {...base} status={status} />);
    expect(text('status-connection')).toBe(label);
  });
});
