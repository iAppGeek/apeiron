import type { CodecName, LoadPreset } from '@apeiron/logos';
import type { ReactElement } from 'react';
import type { ServerStats } from '../state/app-store';
import type { ConnectionStatus } from '../transport/messages';

export type StatusBarProps = {
  status: ConnectionStatus;
  reconnectAttempt: number;
  codec: CodecName;
  /** Exact count at the root level of the grid: rows when flat, groups when grouped. */
  rowCount: number | null;
  /** True when `rowCount` counts root groups rather than rows. */
  grouped: boolean;
  /** Orders in the current view, from the server's summary (leaf rows even when grouped). */
  totalRows?: number | null;
  rttMs: number | null;
  fps: number | null;
  msgsInPerSec: number;
  msgsOutPerSec: number;
  /** Delta messages received per second, before coalescing. */
  deltasPerSec?: number;
  rowsUpdatedPerSec?: number;
  /** Rolling tick-to-screen latency over the last 10 seconds. */
  latencyP50Ms?: number | null;
  latencyP95Ms?: number | null;
  server: ServerStats | null;
  /** The load preset the mock middleware is running; a STRESS pill shows while it is stress. */
  preset?: LoadPreset | null;
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
  const p50 = props.latencyP50Ms ?? null;
  const p95 = props.latencyP95Ms ?? null;
  const latency = p50 === null || p95 === null ? null : { p50, p95 };
  const label = status === 'reconnecting' ? `${STATUS_LABEL[status]} (#${reconnectAttempt})` : STATUS_LABEL[status];
  return (
    <footer className="status-bar" role="status" aria-label="Status bar">
      <div className="status-item">
        <span className={`dot dot-${status}`} aria-hidden="true" />
        <span className="status-value" data-testid="status-connection">
          {label}
        </span>
      </div>
      {props.preset === 'stress' && (
        <span className="stress-pill" data-testid="status-preset" title="Mock middleware load preset: stress">
          STRESS
        </span>
      )}
      <Item label="Codec" value={props.codec === 'msgpack' ? 'msgpack' : 'json'} testId="status-codec" />
      <Item
        label="Rows"
        value={orDash(props.grouped ? (props.totalRows ?? null) : (props.totalRows ?? props.rowCount), (n) => integer.format(n))}
        testId="status-rows"
      />
      {props.grouped && <Item label="Groups" value={orDash(props.rowCount, (n) => integer.format(n))} testId="status-groups" />}
      <Item label="RTT" value={orDash(props.rttMs, (n) => `${integer.format(n)} ms`)} testId="status-rtt" />
      <Item label="FPS" value={orDash(props.fps, (n) => integer.format(n))} testId="status-fps" />
      <Item
        label="Tick-to-screen p50/p95"
        value={latency === null ? '—' : `${integer.format(latency.p50)} / ${integer.format(latency.p95)} ms`}
        testId="status-latency"
      />
      <Item label="Deltas" value={`${oneDecimal.format(props.deltasPerSec ?? 0)}/s`} testId="status-deltas" />
      <Item label="Rows upd" value={`${integer.format(props.rowsUpdatedPerSec ?? 0)}/s`} testId="status-rows-updated" />
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
      <Item
        label="Server lag"
        value={server === null ? '—' : `${oneDecimal.format(server.elLagMs)} ms`}
        testId="status-lag"
      />
    </footer>
  );
}
