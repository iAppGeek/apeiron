import { jsonCodec, msgpackCodec, getCodec, type ClientMsg, type CodecName, type Row, type ServerMsg, type SsrmRequest } from '@apeiron/logos';

type SummaryMsg = Extract<ServerMsg, { t: 'summary' }>;
type Waiter = { resolve: (msg: ServerMsg) => void; reject: (error: Error) => void };

export type Reader = {
  /** Server clock minus local clock, measured from the welcome (ms). */
  serverOffsetMs: number;
  getRows(req: SsrmRequest): Promise<{ rows: Row[]; rowCount: number }>;
  /** Resolves with the next `summary` message to arrive after this call. */
  nextSummary(): Promise<SummaryMsg>;
  close(): void;
};

export type ReaderOptions = {
  /** Direct to antikythera (default ws://127.0.0.1:4000/ws), never through the fault proxy. */
  url?: string;
  traderId?: string;
  codec?: CodecName;
  clientId?: string;
  /** Test seam; defaults to the platform WebSocket. */
  socket?: (url: string) => WebSocket;
};

/** Copies bytes into a plain ArrayBuffer-backed view, which is what `WebSocket.send` accepts. */
const sendable = (frame: string | Uint8Array): string | Uint8Array<ArrayBuffer> => (typeof frame === 'string' ? frame : new Uint8Array(frame));

function decode(data: unknown): ServerMsg {
  if (typeof data === 'string') return jsonCodec.decode(data) as ServerMsg;
  if (data instanceof ArrayBuffer) return msgpackCodec.decode(new Uint8Array(data)) as ServerMsg;
  throw new Error('Unsupported frame type');
}

/**
 * A fresh protocol client for the oracle, speaking the real wire format with the logos codecs. It reads straight from
 * antikythera, so what it sees is the server's truth and does not depend on the page under test.
 */
export async function openReader(options: ReaderOptions = {}): Promise<Reader> {
  const url = options.url ?? 'ws://127.0.0.1:4000/ws';
  const codecName = options.codec ?? 'json';
  const socket = options.socket?.(url) ?? new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  const waiters = new Map<number, Waiter>();
  const summaryWaiters: ((msg: SummaryMsg) => void)[] = [];
  let nextReqId = 1;
  let welcomed: ((offset: number) => void) | null = null;
  let failed: ((error: Error) => void) | null = null;
  let closed = false;

  socket.onmessage = (event): void => {
    const msg = decode(event.data);
    if (msg.t === 'welcome') {
      welcomed?.(msg.serverTime - Date.now());
      return;
    }
    if (msg.t === 'summary') {
      for (const w of summaryWaiters.splice(0)) w(msg);
      return;
    }
    if (msg.t === 'rows' || msg.t === 'filterValues' || msg.t === 'ack' || (msg.t === 'error' && msg.reqId !== undefined)) {
      const waiter = waiters.get(msg.reqId as number);
      if (waiter === undefined) return;
      waiters.delete(msg.reqId as number);
      if (msg.t === 'error') waiter.reject(new Error(`${msg.code}: ${msg.message}`));
      else waiter.resolve(msg);
      return;
    }
    if (msg.t === 'error') failed?.(new Error(`${msg.code}: ${msg.message}`));
  };
  const fail = (error: Error): void => {
    closed = true;
    for (const w of waiters.values()) w.reject(error);
    waiters.clear();
    failed?.(error);
  };
  socket.onclose = (): void => {
    fail(new Error('The reader connection closed'));
  };
  socket.onerror = (): void => {
    fail(new Error('The reader connection failed'));
  };

  const serverOffsetMs = await new Promise<number>((resolve, reject) => {
    welcomed = resolve;
    failed = reject;
    socket.onopen = (): void => {
      const hello: ClientMsg = { t: 'hello', traderId: options.traderId ?? 'ALL', codec: codecName, clientId: options.clientId ?? `oracle-${Math.random().toString(36).slice(2, 8)}` };
      socket.send(sendable(jsonCodec.encode(hello)));
    };
  });
  failed = null;
  welcomed = null;

  const send = (msg: ClientMsg): void => {
    if (closed) throw new Error('The reader connection is closed');
    socket.send(sendable(getCodec(codecName).encode(msg)));
  };

  return {
    serverOffsetMs,
    async getRows(req: SsrmRequest): Promise<{ rows: Row[]; rowCount: number }> {
      const reqId = nextReqId++;
      const reply = await new Promise<ServerMsg>((resolve, reject) => {
        waiters.set(reqId, { resolve, reject });
        send({ t: 'getRows', reqId, req });
      });
      if (reply.t !== 'rows') throw new Error(`Unexpected reply ${reply.t}`);
      return { rows: reply.rows, rowCount: reply.rowCount };
    },
    nextSummary(): Promise<SummaryMsg> {
      return new Promise<SummaryMsg>((resolve) => {
        summaryWaiters.push(resolve);
      });
    },
    close(): void {
      closed = true;
      socket.onclose = null;
      socket.close();
    },
  };
}
