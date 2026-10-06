/**
 * The only surface the protocol layer needs from a WebSocket implementation. `ws` implements it today
 * (see ws-transport.ts); uWebSockets.js could be swapped in by writing another adapter.
 */
export type Frame = string | Uint8Array;

export type Connection = {
  /** Sends a text frame for a string and a binary frame for bytes. A closed connection ignores the send. */
  send(frame: Frame): void;
  close(code?: number, reason?: string): void;
  /** Bytes queued but not yet written to the socket (used for backpressure from phase 5). */
  readonly bufferedAmount: number;
};

export type ConnectionHandlers = {
  onFrame: (frame: Frame) => void;
  onClose: () => void;
};

/** Called once per accepted connection; returns the handlers the transport should drive. */
export type ConnectionHost = (connection: Connection) => ConnectionHandlers;
