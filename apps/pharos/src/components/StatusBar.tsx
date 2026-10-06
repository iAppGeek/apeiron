import type { CodecName } from '@apeiron/logos';
import type { ReactElement } from 'react';
import type { ServerStats } from '../state/app-store';
import type { ConnectionStatus } from '../transport/messages';

export type StatusBarProps = {
  status: ConnectionStatus;
  reconnectAttempt: number;
  codec: CodecName;
  rowCount: number | null;
  /** True when `rowCount` counts root groups, so the label says Groups. */
  grouped: boolean;
  rttMs: number | null;
  fps: number | null;
  msgsInPerSec: number;
  msgsOutPerSec: number;
  server: ServerStats | null;
};

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  closed: 'Disconnected',
};

const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const orDash = (value: number | null, format: (n: number) => string): string =>
  value === null ? '—' : format(value);

function Item({ label, value, testId }: { label: string; value: string; testId: string }): ReactElement {
  return (
    <div className="status-item">
      <span className="status-label">{label}</span>
      <span className="status-value" data-testid={testId}>
        {value}
      </span>
    </div>
  );
}

export function StatusBar(props: StatusBarProps): ReactElement {
  const { status, reconnectAttempt, server } = props;
  const label = status === 'reconnecting' ? `${STATUS_LABEL[status]} (#${reconnectAttempt})` : STATUS_LABEL[status];
  return (
    <footer className="status-bar" role="status" aria-label="Status bar">
      <div className="status-item">
        <span className={`dot dot-${status}`} aria-hidden="true" />
        <span className="status-value" data-testid="status-connection">
          {label}
        </span>
      </div>
      <Item label="Codec" value={props.codec === 'msgpack' ? 'msgpack' : 'json'} testId="status-codec" />
      <Item label={props.grouped ? 'Groups' : 'Rows'} value={orDash(props.rowCount, (n) => integer.format(n))} testId="status-rows" />
      <Item label="RTT" value={orDash(props.rttMs, (n) => `${integer.format(n)} ms`)} testId="status-rtt" />
      <Item label="FPS" value={orDash(props.fps, (n) => integer.format(n))} testId="status-fps" />
      <Item label="In" value={`${oneDecimal.format(props.msgsInPerSec)} msg/s`} testId="status-in" />
      <Item label="Out" value={`${oneDecimal.format(props.msgsOutPerSec)} msg/s`} testId="status-out" />
      <Item
        label="Server CPU"
        value={server === null ? '—' : `${oneDecimal.format(server.cpu)}%`}
        testId="status-cpu"
      />
      <Item
        label="Server RSS"
        value={server === null ? '—' : `${integer.format(server.rssMb)} MB`}
        testId="status-rss"
      />
    </footer>
  );
}
