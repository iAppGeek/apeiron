import {
  getCodec,
  jsonCodec,
  msgpackCodec,
  type ClientMsg,
  type CodecName,
  type ServerMsg,
  isServerMsg,
} from '@apeiron/logos';
import { createClockOffsetEstimator } from '../metrics/latency';
import { createDeltaBatcher, type DeltaMsg } from './delta-coalescer';
import type { Failure, RequestMsg, WorkerToMain } from './messages';

/** The slice of the browser `WebSocket` the core needs, so tests can supply a fake. */
export type SocketLike = {
  readonly readyState: number;
  binaryType: string;
  send(data: string | Uint8Array): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event?: { code?: number }) => void) | null;
  onerror: (() => void) | null;
};

export type Clock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  random(): number;
  /** Next animation frame; where a worker has no `requestAnimationFrame` the core falls back to a 16ms timeout. */
  nextFrame?(fn: () => void): unknown;
  cancelFrame?(handle: unknown): void;
};

export type CoreOptions = {
  pingIntervalMs: number;
  statsIntervalMs: number;
  requestTimeoutMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** 0 disables jitter; 0.2 spreads each delay by up to plus or minus 20%. */
  backoffJitter: number;
};

export const DEFAULT_CORE_OPTIONS: CoreOptions = {
  pingIntervalMs: 2000,
  statsIntervalMs: 1000,
  requestTimeoutMs: 30_000,
  backoffBaseMs: 500,
  backoffMaxMs: 10_000,
  backoffJitter: 0.2,
};

export type CoreDeps = {
  createSocket: (url: string) => SocketLike;
  emit: (event: WorkerToMain) => void;
  clock: Clock;
  clientId: string;
  options?: Partial<CoreOptions>;
};

export type ConnectionCore = {
  connect(url: string): void;
  hello(id: number, traderId: string, codec: CodecName): void;
  request(msg: RequestMsg): void;
  close(): void;
};

const OPEN = 1;

const failure = (code: Failure['code'], message: string): Failure => ({ code, message });

/** Frames are self-describing: text is JSON, binary is msgpack. This avoids any race around a codec switch. */
function decodeFrame(data: unknown): unknown {
  if (typeof data === 'string') return jsonCodec.decode(data);
  if (data instanceof ArrayBuffer) return msgpackCodec.decode(new Uint8Array(data));
  if (data instanceof Uint8Array) return msgpackCodec.decode(data);
  throw new Error('Unsupported frame type');
}

type Pending = { timer: unknown };
type InflightHello = { ids: number[]; traderId: string; codec: CodecName };

/**
 * All the transport logic that lives inside the Web Worker, free of `Worker` and `WebSocket` so it is
 * unit-testable. It owns the socket, speaks the Appendix C handshake (JSON `hello` first, then the
 * negotiated codec), matches responses to requests by `reqId`, pings for round-trip time, and
 * reconnects with exponential backoff (re-sending `hello`).
 */
export function createConnectionCore(deps: CoreDeps): ConnectionCore {
  const options: CoreOptions = { ...DEFAULT_CORE_OPTIONS, ...deps.options };
  const { clock, emit } = deps;

  let url = '';
  let socket: SocketLike | null = null;
  let closedByUser = false;
  let attempt = 0;
  let reconnectTimer: unknown = null;
  let pingTimer: unknown = null;
  let statsTimer: unknown = null;

  let traderId = 'ALL';
  let codecName: CodecName = 'json';
  /** Hello ids issued while no socket was open; one hello on open resolves them all. */
  let queuedHelloIds: number[] = [];
  /** One entry per hello sent and not yet answered: the ids it resolves and the settings it asked for. */
  let inflightHellos: InflightHello[] = [];
  /** The last settings the server confirmed with a welcome; a rejected hello falls back to these. */
  let confirmed: { traderId: string; codec: CodecName } = { traderId: 'ALL', codec: 'json' };
  const pending = new Map<number, Pending>();

  let msgsIn = 0;
  let msgsOut = 0;
  let deltasIn = 0;
  let rttMs: number | null = null;
  const clockOffset = createClockOffsetEstimator();

  // Deltas pass straight through at normal rates; above 20/s they are merged once per animation frame.
  const batcher = createDeltaBatcher({
    now: () => clock.now(),
    nextFrame: (fn) => (clock.nextFrame !== undefined ? clock.nextFrame(fn) : clock.setTimeout(fn, 16)),
    cancelFrame: (handle) => {
      if (clock.cancelFrame !== undefined) clock.cancelFrame(handle);
      else clock.clearTimeout(handle);
    },
    emit: (delta: DeltaMsg) => {
      emit({ kind: 'message', msg: delta });
    },
  });

  const isOpen = (): boolean => socket !== null && socket.readyState === OPEN;

  const emitStatus = (status: 'connecting' | 'connected' | 'reconnecting' | 'closed'): void => {
    emit({ kind: 'status', status, attempt, codec: codecName });
  };

  const sendRaw = (data: string | Uint8Array): void => {
    if (socket === null || !isOpen()) return;
    socket.send(data);
    msgsOut += 1;
  };

  const sendHello = (): void => {
    const msg: ClientMsg = { t: 'hello', traderId, codec: codecName, clientId: deps.clientId };
    // The first frame, and every hello, is JSON text whatever codec is being negotiated.
    sendRaw(jsonCodec.encode(msg));
  };

  const sendMsg = (msg: ClientMsg): void => {
    sendRaw(getCodec(codecName).encode(msg));
  };

  const failAllPending = (f: Failure): void => {
    for (const [reqId, p] of pending) {
      clock.clearTimeout(p.timer);
      emit({ kind: 'response', reqId, ok: false, ...f });
    }
    pending.clear();
    for (const { ids } of inflightHellos) {
      for (const id of ids) emit({ kind: 'hello-result', id, ok: false, ...f });
    }
    inflightHellos = [];
  };

  const stopTimers = (): void => {
    if (pingTimer !== null) clock.clearInterval(pingTimer);
    pingTimer = null;
    if (statsTimer !== null) clock.clearInterval(statsTimer);
    statsTimer = null;
  };

  const startTimers = (): void => {
    stopTimers();
    pingTimer = clock.setInterval(() => {
      if (isOpen()) sendMsg({ t: 'ping', ts: clock.now() });
    }, options.pingIntervalMs);
    statsTimer = clock.setInterval(() => {
      const seconds = options.statsIntervalMs / 1000;
      emit({
        kind: 'stats',
        msgsIn: msgsIn / seconds,
        msgsOut: msgsOut / seconds,
        deltasIn: deltasIn / seconds,
        rttMs,
        clockOffsetMs: clockOffset.offsetMs(),
      });
      msgsIn = 0;
      msgsOut = 0;
      deltasIn = 0;
    }, options.statsIntervalMs);
  };

  const scheduleReconnect = (): void => {
    if (closedByUser || reconnectTimer !== null) return;
    const base = Math.min(options.backoffMaxMs, options.backoffBaseMs * 2 ** attempt);
    const jitter = options.backoffJitter === 0 ? 0 : (clock.random() * 2 - 1) * options.backoffJitter;
    const delay = Math.round(base * (1 + jitter));
    attempt += 1;
    emitStatus('reconnecting');
    reconnectTimer = clock.setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
  };

  const onServerMsg = (msg: ServerMsg): void => {
    switch (msg.t) {
      case 'welcome': {
        attempt = 0;
        const hello = inflightHellos.shift();
        const ids = hello?.ids ?? [];
        if (hello !== undefined) confirmed = { traderId: hello.traderId, codec: hello.codec };
        emitStatus('connected');
        // Measure the round trip straight away rather than waiting for the first interval tick.
        sendMsg({ t: 'ping', ts: clock.now() });
        for (const id of ids) emit({ kind: 'hello-result', id, ok: true, welcome: msg });
        emit({ kind: 'message', msg });
        return;
      }
      case 'pong': {
        const receivedAt = clock.now();
        rttMs = Math.max(0, receivedAt - msg.ts);
        clockOffset.addSample(msg.ts, msg.serverTs, receivedAt);
        return;
      }
      case 'delta':
        deltasIn += 1;
        batcher.push(msg);
        return;
      case 'rows':
      case 'filterValues':
      case 'ack':
        if (settle(msg.reqId, { ok: true, msg })) return;
        emit({ kind: 'message', msg });
        return;
      case 'error': {
        if (msg.reqId !== undefined) {
          if (settle(msg.reqId, { ok: false, ...failure(msg.code, msg.message) })) return;
          emit({ kind: 'message', msg });
          return;
        }
        const hello = inflightHellos.shift();
        if (hello !== undefined) {
          traderId = confirmed.traderId;
          codecName = confirmed.codec;
          for (const id of hello.ids) emit({ kind: 'hello-result', id, ok: false, ...failure(msg.code, msg.message) });
          return;
        }
        emit({ kind: 'message', msg });
        return;
      }
      default:
        emit({ kind: 'message', msg });
    }
  };

  const settle = (
    reqId: number,
    result: { ok: true; msg: ServerMsg } | ({ ok: false } & Failure),
  ): boolean => {
    const p = pending.get(reqId);
    if (p === undefined) return false;
    clock.clearTimeout(p.timer);
    pending.delete(reqId);
    emit({ kind: 'response', reqId, ...result });
    return true;
  };

  const onFrame = (data: unknown): void => {
    msgsIn += 1;
    let decoded: unknown;
    try {
      decoded = decodeFrame(data);
    } catch (error) {
      emit({
        kind: 'message',
        msg: { t: 'error', code: 'BAD_FRAME', message: error instanceof Error ? error.message : 'Undecodable frame' },
      });
      return;
    }
    if (!isServerMsg(decoded)) return;
    onServerMsg(decoded);
  };

  function open(): void {
    emitStatus(attempt === 0 ? 'connecting' : 'reconnecting');
    const ws = deps.createSocket(url);
    ws.binaryType = 'arraybuffer';
    socket = ws;
    ws.onopen = (): void => {
      if (socket !== ws) return;
      inflightHellos = [{ ids: queuedHelloIds, traderId, codec: codecName }];
      queuedHelloIds = [];
      sendHello();
      startTimers();
    };
    ws.onmessage = (event): void => {
      if (socket === ws) onFrame(event.data);
    };
    const onGone = (): void => {
      if (socket !== ws) return;
      socket = null;
      stopTimers();
      rttMs = null;
      failAllPending(failure('DISCONNECTED', 'Connection lost'));
      if (closedByUser) {
        emitStatus('closed');
        return;
      }
      scheduleReconnect();
    };
    ws.onclose = (event): void => {
      if (socket !== ws) return;
      // Deltas held back for a frame belong to the old connection; hand them over before it is declared lost.
      batcher.flush();
      if (!closedByUser) emit({ kind: 'closed', code: event?.code ?? null });
      onGone();
    };
    ws.onerror = (): void => {
      // A close event always follows an error; reconnection is handled there.
    };
  }

  return {
    connect(nextUrl: string): void {
      url = nextUrl;
      closedByUser = false;
      attempt = 0;
      if (socket !== null) return;
      open();
    },

    hello(id: number, nextTraderId: string, nextCodec: CodecName): void {
      traderId = nextTraderId;
      if (!isOpen()) {
        codecName = nextCodec;
        queuedHelloIds.push(id);
        return;
      }
      codecName = nextCodec;
      inflightHellos.push({ ids: [id], traderId, codec: nextCodec });
      sendHello();
    },

    request(msg: RequestMsg): void {
      if (!isOpen()) {
        emit({ kind: 'response', reqId: msg.reqId, ok: false, ...failure('DISCONNECTED', 'Not connected') });
        return;
      }
      const timer = clock.setTimeout(() => {
        if (pending.delete(msg.reqId)) {
          emit({
            kind: 'response',
            reqId: msg.reqId,
            ok: false,
            ...failure('TIMEOUT', `No response after ${options.requestTimeoutMs}ms`),
          });
        }
      }, options.requestTimeoutMs);
      pending.set(msg.reqId, { timer });
      sendMsg(msg);
    },

    close(): void {
      closedByUser = true;
      batcher.flush();
      if (reconnectTimer !== null) clock.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      stopTimers();
      if (socket !== null) {
        const ws = socket;
        ws.close();
        socket = null;
        failAllPending(failure('DISCONNECTED', 'Connection closed'));
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
      }
      emitStatus('closed');
    },
  };
}
