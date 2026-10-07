import WebSocket, { type RawData } from 'ws';

/** What the load generator needs from a WebSocket: text and binary frames in and out, and the ability to stop reading. */
export type SocketLike = {
  /** A string goes out as a text frame, bytes as a binary frame. */
  send(data: string | Uint8Array): void;
  close(code?: number): void;
  /** Stops reading from the TCP socket, so the server's writes back up. */
  pauseReading(): void;
  resumeReading(): void;
  /** A text frame arrives as a string, a binary frame as bytes. */
  onMessage(listener: (data: string | Uint8Array) => void): void;
  onClose(listener: (code: number) => void): void;
  onError(listener: (error: Error) => void): void;
};

export type Connector = (url: string) => Promise<SocketLike>;

type WithSocket = { _socket?: { pause(): void; resume(): void } };

function toData(raw: RawData, isBinary: boolean): string | Uint8Array {
  if (!isBinary) return Array.isArray(raw) ? Buffer.concat(raw).toString('utf8') : raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw);
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return raw;
}

export function adaptWebSocket(ws: WebSocket): SocketLike {
  return {
    send: (data): void => ws.send(data, { binary: typeof data !== 'string' }),
    close: (code): void => ws.close(code),
    pauseReading: (): void => (ws as unknown as WithSocket)._socket?.pause(),
    resumeReading: (): void => (ws as unknown as WithSocket)._socket?.resume(),
    onMessage: (listener): void => {
      ws.on('message', (raw: RawData, isBinary: boolean) => listener(toData(raw, isBinary)));
    },
    onClose: (listener): void => {
      ws.on('close', (code: number) => listener(code));
    },
    onError: (listener): void => {
      ws.on('error', listener);
    },
  };
}

/** Opens a real WebSocket (no compression, like the grid's own connection). */
export const connectWebSocket: Connector = (url) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false });
    ws.once('open', () => resolve(adaptWebSocket(ws)));
    ws.once('error', reject);
  });
