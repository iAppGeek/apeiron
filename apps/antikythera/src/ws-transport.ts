import type { RawData, WebSocket } from 'ws';
import type { Connection, ConnectionHost, Frame } from './transport.js';

/** Converts what `ws` delivers into a text frame (string) or a binary frame (bytes). */
export function toFrame(raw: RawData, isBinary: boolean): Frame {
  if (!isBinary) return Array.isArray(raw) ? Buffer.concat(raw).toString('utf8') : raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw);
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return raw;
}

const OPEN = 1;

export type HeartbeatOptions = {
  /** How often the server pings and checks for silence (default 5000). */
  intervalMs: number;
  /** A client that sends no frame and answers no ping for this long is terminated (default 15000). */
  timeoutMs: number;
};

export const DEFAULT_HEARTBEAT: HeartbeatOptions = { intervalMs: 5000, timeoutMs: 15_000 };

/** Adapts a `ws` socket to the transport interface and starts driving the host's handlers. */
export function attachWebSocket(
  socket: WebSocket,
  host: ConnectionHost,
  onError: (error: Error) => void,
  heartbeat: HeartbeatOptions | null = DEFAULT_HEARTBEAT,
): void {
  const connection: Connection = {
    send: (frame): void => {
      if (socket.readyState !== OPEN) return;
      socket.send(frame, { binary: typeof frame !== 'string' });
    },
    close: (code, reason): void => socket.close(code, reason),
    get bufferedAmount(): number {
      return socket.bufferedAmount;
    },
  };
  const handlers = host(connection);
  let lastSeen = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;
  if (heartbeat !== null) {
    // A half-open peer never closes; terminating it fires `close`, which releases the session, tracker and view refs.
    timer = setInterval(() => {
      if (Date.now() - lastSeen > heartbeat.timeoutMs) {
        socket.terminate();
        return;
      }
      if (socket.readyState === OPEN) socket.ping();
    }, heartbeat.intervalMs);
    timer.unref();
    socket.on('pong', () => {
      lastSeen = Date.now();
    });
  }
  socket.on('message', (raw: RawData, isBinary: boolean) => {
    lastSeen = Date.now();
    handlers.onFrame(toFrame(raw, isBinary));
  });
  socket.on('close', () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    handlers.onClose();
  });
  socket.on('error', onError);
}
