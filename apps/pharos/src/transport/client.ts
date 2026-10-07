import type { CodecName, CommandAction, LoadPreset, Row, ServerMsg, SsrmRequest } from '@apeiron/logos';
import type {
  ConnectionStatus,
  Failure,
  FailureCode,
  MainToWorker,
  RequestMsg,
  WelcomeMsg,
  WorkerToMain,
} from './messages';

/** The slice of `Worker` the client needs. */
export type WorkerLike = {
  postMessage(message: MainToWorker): void;
  onmessage: ((event: { data: WorkerToMain }) => void) | null;
  terminate(): void;
};

export type RowsResult = { rows: Row[]; rowCount: number; ms: number };

export type StatusEvent = { status: ConnectionStatus; attempt: number; codec: CodecName; reconnects: number };
export type StatsEvent = {
  msgsIn: number;
  msgsOut: number;
  deltasIn: number;
  rttMs: number | null;
  clockOffsetMs: number | null;
};

export type ClosedEvent = { code: number | null; reason: string };

export type ClientEvents = {
  status: StatusEvent;
  /** Server messages that are not answers to a request: delta, summary, welcome, stray errors. */
  message: ServerMsg;
  stats: StatsEvent;
  /** The socket closed on its own (not through `dispose`). */
  closed: ClosedEvent;
};

/** A request or hello that failed. `code` is the server's `ErrorCode`, or a transport code. */
export class RequestError extends Error {
  readonly code: FailureCode;

  constructor(failure: Failure) {
    super(failure.message);
    this.name = 'RequestError';
    this.code = failure.code;
  }
}

export type BlotterClient = {
  connect(url: string): void;
  /** Resolves with the server's welcome once it accepts the trader and codec. */
  hello(traderId: string, codec: CodecName): Promise<WelcomeMsg>;
  getRows(req: SsrmRequest): Promise<RowsResult>;
  setFilterValues(colId: string): Promise<string[]>;
  /** Asks the server to switch the mock middleware load preset; resolves when the server has published it. */
  control(preset: LoadPreset): Promise<void>;
  /**
   * Sends a Cancel, Pause or Resume for an order. Resolves on the server's ack, which arrives after the status
   * change has been broadcast; rejects with a {@link RequestError} carrying the server's code (INVALID_TRANSITION,
   * UNKNOWN_ORDER, INTERNAL for a timeout) or a transport code.
   */
  command(orderId: string, action: CommandAction): Promise<void>;
  on<E extends keyof ClientEvents>(event: E, handler: (payload: ClientEvents[E]) => void): () => void;
  /** Requests and hellos still waiting for an answer; zero once every one has been answered or failed. */
  pending(): number;
  dispose(): void;
};

type Settler<T> = { resolve: (value: T) => void; reject: (reason: RequestError) => void };

/** Main-thread facade over the transport worker. */
export function createBlotterClient(worker: WorkerLike): BlotterClient {
  let nextId = 1;
  const requests = new Map<number, Settler<ServerMsg>>();
  const hellos = new Map<number, Settler<WelcomeMsg>>();
  const listeners: { [E in keyof ClientEvents]: Set<(payload: ClientEvents[E]) => void> } = {
    status: new Set(),
    message: new Set(),
    stats: new Set(),
    closed: new Set(),
  };

  const emit = <E extends keyof ClientEvents>(event: E, payload: ClientEvents[E]): void => {
    for (const handler of [...listeners[event]]) handler(payload);
  };

  worker.onmessage = (event): void => {
    const data = event.data;
    switch (data.kind) {
      case 'status':
        emit('status', { status: data.status, attempt: data.attempt, codec: data.codec, reconnects: data.reconnects });
        return;
      case 'message':
        emit('message', data.msg);
        return;
      case 'stats':
        emit('stats', {
          msgsIn: data.msgsIn,
          msgsOut: data.msgsOut,
          deltasIn: data.deltasIn,
          rttMs: data.rttMs,
          clockOffsetMs: data.clockOffsetMs,
        });
        return;
      case 'closed':
        emit('closed', { code: data.code, reason: data.reason });
        return;
      case 'response': {
        const settler = requests.get(data.reqId);
        if (settler === undefined) return;
        requests.delete(data.reqId);
        if (data.ok) settler.resolve(data.msg);
        else settler.reject(new RequestError(data));
        return;
      }
      case 'hello-result': {
        const settler = hellos.get(data.id);
        if (settler === undefined) return;
        hellos.delete(data.id);
        if (data.ok) settler.resolve(data.welcome);
        else settler.reject(new RequestError(data));
        return;
      }
    }
  };

  const request = (build: (reqId: number) => RequestMsg): Promise<ServerMsg> =>
    new Promise<ServerMsg>((resolve, reject) => {
      const reqId = nextId++;
      requests.set(reqId, { resolve, reject });
      worker.postMessage({ kind: 'request', msg: build(reqId) });
    });

  return {
    connect(url: string): void {
      worker.postMessage({ kind: 'connect', url });
    },

    hello(traderId: string, codec: CodecName): Promise<WelcomeMsg> {
      return new Promise<WelcomeMsg>((resolve, reject) => {
        const id = nextId++;
        hellos.set(id, { resolve, reject });
        worker.postMessage({ kind: 'hello', id, traderId, codec });
      });
    },

    async getRows(req: SsrmRequest): Promise<RowsResult> {
      const msg = await request((reqId) => ({ t: 'getRows', reqId, req }));
      if (msg.t !== 'rows') throw new RequestError({ code: 'INTERNAL', message: `Unexpected reply: ${msg.t}` });
      return { rows: msg.rows, rowCount: msg.rowCount, ms: msg.ms };
    },

    async setFilterValues(colId: string): Promise<string[]> {
      const msg = await request((reqId) => ({ t: 'setFilterValues', reqId, colId }));
      if (msg.t !== 'filterValues') throw new RequestError({ code: 'INTERNAL', message: `Unexpected reply: ${msg.t}` });
      return msg.values;
    },

    async control(preset: LoadPreset): Promise<void> {
      const msg = await request((reqId) => ({ t: 'control', reqId, preset }));
      if (msg.t !== 'ack') throw new RequestError({ code: 'INTERNAL', message: `Unexpected reply: ${msg.t}` });
    },

    async command(orderId: string, action: CommandAction): Promise<void> {
      const msg = await request((reqId) => ({ t: 'command', reqId, orderId, action }));
      if (msg.t !== 'ack') throw new RequestError({ code: 'INTERNAL', message: `Unexpected reply: ${msg.t}` });
    },

    on<E extends keyof ClientEvents>(event: E, handler: (payload: ClientEvents[E]) => void): () => void {
      listeners[event].add(handler);
      return (): void => {
        listeners[event].delete(handler);
      };
    },

    pending(): number {
      return requests.size + hellos.size;
    },

    dispose(): void {
      worker.postMessage({ kind: 'close' });
      worker.onmessage = null;
      worker.terminate();
      const gone = new RequestError({ code: 'DISCONNECTED', message: 'Client disposed' });
      for (const settler of requests.values()) settler.reject(gone);
      for (const settler of hellos.values()) settler.reject(gone);
      requests.clear();
      hellos.clear();
    },
  };
}
