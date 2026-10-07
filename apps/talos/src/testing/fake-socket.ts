import { jsonCodec, msgpackCodec, type ClientMsg, type ServerMsg } from '@apeiron/logos';
import type { SocketLike } from '../socket.js';

export type SentFrame = { binary: boolean; msg: ClientMsg };

/** An in-memory socket: records what the client sends and lets a test play the server. */
export class FakeSocket implements SocketLike {
  readonly sent: SentFrame[] = [];
  paused = false;
  closedWith: number | null = null;
  private messageListener: (data: string | Uint8Array) => void = () => undefined;
  private closeListener: (code: number) => void = () => undefined;
  /** Called after every client frame, so a test can answer it. */
  onSend: (frame: SentFrame, socket: FakeSocket) => void = () => undefined;

  send(data: string | Uint8Array): void {
    const binary = typeof data !== 'string';
    const msg = (binary ? msgpackCodec.decode(data) : jsonCodec.decode(data)) as ClientMsg;
    const frame = { binary, msg };
    this.sent.push(frame);
    this.onSend(frame, this);
  }

  close(code = 1000): void {
    this.closedWith = code;
    this.closeListener(code);
  }

  pauseReading(): void {
    this.paused = true;
  }

  resumeReading(): void {
    this.paused = false;
  }

  onMessage(listener: (data: string | Uint8Array) => void): void {
    this.messageListener = listener;
  }

  onClose(listener: (code: number) => void): void {
    this.closeListener = listener;
  }

  onError(): void {
    return;
  }

  /** Delivers a server message as a text (JSON) or binary (msgpack) frame. */
  deliver(msg: ServerMsg, codec: 'json' | 'msgpack' = 'json'): void {
    this.messageListener(codec === 'json' ? jsonCodec.encode(msg) : msgpackCodec.encode(msg));
  }

  /** Delivers raw bytes or text as they are. */
  deliverRaw(data: string | Uint8Array): void {
    this.messageListener(data);
  }

  serverClose(code: number): void {
    this.closeListener(code);
  }

  last<T extends ClientMsg['t']>(t: T): Extract<ClientMsg, { t: T }> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const m = this.sent[i]?.msg;
      if (m?.t === t) return m as Extract<ClientMsg, { t: T }>;
    }
    return undefined;
  }
}

export const welcome = (serverTime = 1_000, preset: 'medium' | 'stress' | null = null): ServerMsg => ({
  t: 'welcome',
  serverTime,
  traders: [],
  columnsVersion: 'x',
  preset,
});

export type AutoServerOptions = {
  /** Rows returned for every getRows. */
  rows?: Record<string, string | number>[];
  rowCount?: number;
  /** Replies to a command with this error code instead of an ack. */
  commandError?: string;
  /** Called for every client message before it is answered. */
  seen?: (msg: ClientMsg, binary: boolean) => void;
  /** Stays silent for these message types. */
  ignore?: ClientMsg['t'][];
  serverClock?: () => number;
};

/** Makes a fake socket answer like the real server: welcome, rows, ack and pong, in the codec of the request frame. */
export function autoServer(socket: FakeSocket, options: AutoServerOptions = {}): void {
  socket.onSend = ({ binary, msg }, s): void => {
    options.seen?.(msg, binary);
    if (options.ignore?.includes(msg.t) === true) return;
    const codec = binary ? 'msgpack' : 'json';
    switch (msg.t) {
      case 'hello':
        s.deliver(welcome(options.serverClock?.() ?? Date.now()), 'json');
        return;
      case 'getRows':
        s.deliver({ t: 'rows', reqId: msg.reqId, rows: options.rows ?? [], rowCount: options.rowCount ?? 1_000, ms: 1 }, codec);
        return;
      case 'command':
        s.deliver(options.commandError === undefined ? { t: 'ack', reqId: msg.reqId } : { t: 'error', reqId: msg.reqId, code: options.commandError as never, message: 'x' }, codec);
        return;
      case 'control':
        s.deliver({ t: 'ack', reqId: msg.reqId }, codec);
        return;
      case 'ping':
        s.deliver({ t: 'pong', ts: msg.ts, serverTs: options.serverClock?.() ?? Date.now() }, codec);
        return;
      case 'setFilterValues':
        return;
    }
  };
}
