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

/** Adapts a `ws` socket to the transport interface and starts driving the host's handlers. */
export function attachWebSocket(
  socket: WebSocket,
  host: ConnectionHost,
  onError: (error: Error) => void,
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
  socket.on('message', (raw: RawData, isBinary: boolean) => handlers.onFrame(toFrame(raw, isBinary)));
  socket.on('close', () => handlers.onClose());
  socket.on('error', onError);
}
