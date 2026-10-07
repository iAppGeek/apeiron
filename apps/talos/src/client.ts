import {
  jsonCodec,
  msgpackCodec,
  getCodec,
  type ClientMsg,
  type CodecName,
  type CommandAction,
  type LoadPreset,
  type Row,
  type ServerMsg,
  type SsrmRequest,
} from '@apeiron/logos';
import type { Recorder, RowsKind } from './recorder.js';
import type { Clock } from './schedule.js';
import type { SocketLike } from './socket.js';

export type RowsOutcome = { ok: true; rows: Row[]; rowCount: number; ms: number; binary: boolean } | { ok: false; code: string; ms: number };

export type ClientDeps = {
  clientId: string;
  traderId: string;
  codec: CodecName;
  socket: SocketLike;
  clock: Clock;
  recorder: Recorder;
  /** A client whose latencies are not part of the aggregate (the slow consumer reads late on purpose). */
  excludeLatency?: boolean;
  /** Called when a welcome or summary reports a load preset different from the last one seen. */
  onPreset?: (preset: LoadPreset | null, at: number) => void;
  requestTimeoutMs?: number;
};

type Pending = {
  kind: 'rows' | 'command' | 'control';
  intendedAt: number;
  cold: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve: (msg: ServerMsg | { t: 'timeout' } | { t: 'closed' }, binary: boolean) => void;
};

const OFFSET_WINDOW = 8;

/**
 * One protocol connection as a load-test client. It decodes every frame by its type (text is JSON, binary is
 * msgpack), correlates responses by `reqId`, measures latency from each request's intended send time, estimates the
 * server's clock offset from ping/pong, and tracks the LIVE orders it has been shown so commands have a target.
 */
export class TalosClient {
  codec: CodecName;
  closed = false;
  closeCode: number | null = null;
  slowConsumerAt: number | null = null;
  lastPreset: LoadPreset | null = null;
  readonly liveOrders = new Map<string, string>();
  private nextReq = 1;
  private readonly pending = new Map<number, Pending>();
  private helloWaiter: ((msg: ServerMsg | null) => void) | null = null;
  private offsets: { rtt: number; offset: number }[] = [];
  private helloSentAt = 0;
  private readonly timeoutMs: number;

  constructor(private readonly deps: ClientDeps) {
    this.codec = deps.codec;
    this.timeoutMs = deps.requestTimeoutMs ?? 15_000;
    deps.socket.onMessage((data) => this.onData(data));
    deps.socket.onClose((code) => this.onClosed(code));
    deps.socket.onError(() => undefined);
  }

  get clientId(): string {
    return this.deps.clientId;
  }

  /** Estimated `server clock - local clock` in ms, from the lowest-latency ping/pong seen. */
  get clockOffsetMs(): number {
    if (this.offsets.length === 0) return 0;
    return this.offsets.reduce((best, s) => (s.rtt < best.rtt ? s : best)).offset;
  }

  /** Sends `hello` (always JSON text), switching to `codec` for everything after it, and waits for `welcome`. */
  hello(codec: CodecName = this.codec, timeoutMs = 10_000): Promise<boolean> {
    this.codec = codec;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.helloWaiter = null;
        resolve(false);
      }, timeoutMs);
      this.helloWaiter = (msg): void => {
        clearTimeout(timer);
        resolve(msg !== null);
      };
      this.helloSentAt = this.deps.clock.now();
      const text = JSON.stringify({ t: 'hello', traderId: this.deps.traderId, codec, clientId: this.deps.clientId } satisfies ClientMsg);
      this.emit(text, 'hello', 'json');
    });
  }

  /** `cold`: true for the first request of a view change, `'startup'` for a client's very first view, false for scrolling. */
  getRows(req: SsrmRequest, intendedAt: number, cold: boolean | 'startup'): Promise<RowsOutcome> {
    const kind: RowsKind = cold === 'startup' ? 'startup' : cold ? 'cold' : 'warm';
    return this.request('rows', intendedAt, cold === true, { t: 'getRows', reqId: this.nextReq, req }).then((r): RowsOutcome => {
      const at = this.deps.clock.now();
      const ms = at - intendedAt;
      if (r.msg.t === 'rows') {
        if (this.deps.excludeLatency !== true) this.deps.recorder.rows({ codec: this.codec, kind, at, ms, serverMs: r.msg.ms });
        return { ok: true, rows: r.msg.rows, rowCount: r.msg.rowCount, ms, binary: r.binary };
      }
      const code = r.msg.t === 'error' ? r.msg.code : r.msg.t === 'timeout' ? 'TIMEOUT' : 'CLOSED';
      if (r.msg.t === 'timeout' && this.deps.excludeLatency !== true) this.deps.recorder.rows({ codec: this.codec, kind, at, ms, serverMs: 0 });
      if (r.msg.t !== 'error' && r.msg.t !== 'closed' && this.deps.excludeLatency !== true) this.deps.recorder.error({ codec: this.codec, code, at });
      return { ok: false, code, ms };
    });
  }

  /** Resolves `'ack'` or the failure code (an error code, `TIMEOUT` or `CLOSED`). */
  command(orderId: string, action: CommandAction, intendedAt: number): Promise<string> {
    return this.request('command', intendedAt, false, { t: 'command', reqId: this.nextReq, orderId, action }).then((r) => {
      const at = this.deps.clock.now();
      const ms = at - intendedAt;
      if (r.msg.t === 'ack') {
        this.deps.recorder.command({ codec: this.codec, at, ms, ok: true });
        return 'ack';
      }
      const code = r.msg.t === 'error' ? r.msg.code : r.msg.t === 'timeout' ? 'TIMEOUT' : 'CLOSED';
      this.deps.recorder.command({ codec: this.codec, at, ms, ok: false, code });
      return code;
    });
  }

  /** Asks hermes (through the server) for a load preset. Resolves true when acknowledged. */
  async control(preset: LoadPreset): Promise<boolean> {
    const r = await this.request('control', this.deps.clock.now(), false, { t: 'control', reqId: this.nextReq, preset });
    return r.msg.t === 'ack';
  }

  ping(): void {
    this.emit(this.encode({ t: 'ping', ts: this.deps.clock.now() }), 'ping', this.codec);
  }

  close(code = 1000): void {
    this.deps.socket.close(code);
  }

  pauseReading(): void {
    this.deps.socket.pauseReading();
  }

  resumeReading(): void {
    this.deps.socket.resumeReading();
  }

  private encode(msg: ClientMsg): string | Uint8Array {
    return getCodec(this.codec).encode(msg);
  }

  private emit(frame: string | Uint8Array, type: string, codec: CodecName): void {
    if (this.closed) return;
    this.deps.socket.send(frame);
    this.deps.recorder.frame({ codec, direction: 'out', type, bytes: typeof frame === 'string' ? Buffer.byteLength(frame) : frame.byteLength });
  }

  private request(kind: Pending['kind'], intendedAt: number, cold: boolean, msg: Extract<ClientMsg, { reqId: number }>): Promise<{ msg: ServerMsg | { t: 'timeout' } | { t: 'closed' }; binary: boolean }> {
    const reqId = this.nextReq++;
    return new Promise((resolve) => {
      if (this.closed) {
        resolve({ msg: { t: 'closed' }, binary: false });
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        resolve({ msg: { t: 'timeout' }, binary: false });
      }, this.timeoutMs);
      this.pending.set(reqId, { kind, intendedAt, cold, timer, resolve: (m, binary) => resolve({ msg: m, binary }) });
      this.emit(this.encode({ ...msg, reqId }), msg.t, this.codec);
    });
  }

  private settle(reqId: number | undefined, msg: ServerMsg, binary: boolean): void {
    if (reqId === undefined) return;
    const p = this.pending.get(reqId);
    if (p === undefined) return;
    clearTimeout(p.timer);
    this.pending.delete(reqId);
    p.resolve(msg, binary);
  }

  private notePreset(preset: LoadPreset | null | undefined, at: number): void {
    if (preset === undefined) return;
    if (preset !== this.lastPreset) {
      this.lastPreset = preset;
      this.deps.onPreset?.(preset, at);
    }
  }

  private noteOrder(orderId: string, status: unknown): void {
    if (status === 'LIVE' || status === 'PAUSED') this.liveOrders.set(orderId, status);
    else if (typeof status === 'string') this.liveOrders.delete(orderId);
  }

  private onData(data: string | Uint8Array): void {
    const at = this.deps.clock.now();
    const binary = typeof data !== 'string';
    let msg: ServerMsg;
    try {
      msg = (binary ? msgpackCodec.decode(data) : jsonCodec.decode(data)) as ServerMsg;
    } catch {
      this.deps.recorder.error({ codec: binary ? 'msgpack' : 'json', code: 'CLIENT_BAD_FRAME', at });
      return;
    }
    const frameCodec: CodecName = binary ? 'msgpack' : 'json';
    this.deps.recorder.frame({ codec: frameCodec, direction: 'in', type: msg.t, bytes: typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength });
    switch (msg.t) {
      case 'welcome':
        this.addOffset(this.helloSentAt, at, msg.serverTime);
        this.notePreset(msg.preset, at);
        this.helloWaiter?.(msg);
        this.helloWaiter = null;
        return;
      case 'rows':
        for (const row of msg.rows) if (typeof row.orderId === 'string') this.noteOrder(row.orderId, row.status);
        this.settle(msg.reqId, msg, binary);
        return;
      case 'ack':
        this.settle(msg.reqId, msg, binary);
        return;
      case 'error':
        if (msg.code === 'SLOW_CONSUMER') this.slowConsumerAt = at;
        if (this.deps.excludeLatency !== true || msg.code === 'SLOW_CONSUMER') this.deps.recorder.error({ codec: frameCodec, code: msg.code, at });
        this.settle(msg.reqId, msg, binary);
        return;
      case 'delta': {
        if (this.deps.excludeLatency !== true) {
          const onServerClock = at + this.clockOffsetMs;
          this.deps.recorder.delta({ codec: frameCodec, at, ms: onServerClock - msg.serverTs, e2eMs: onServerClock - msg.srcTs });
        }
        for (const add of msg.adds) for (const row of add.rows) this.noteOrder(row.orderId, row.status);
        for (const update of msg.updates) for (const row of update.rows) if (row.status !== undefined) this.noteOrder(row.orderId, row.status);
        return;
      }
      case 'summary':
        this.notePreset(msg.preset, at);
        return;
      case 'pong':
        this.addOffset(msg.ts, at, msg.serverTs);
        return;
      case 'filterValues':
        return;
    }
  }

  private addOffset(sentAt: number, receivedAt: number, serverTs: number): void {
    const rtt = receivedAt - sentAt;
    if (sentAt <= 0 || rtt < 0) return;
    this.offsets.push({ rtt, offset: serverTs - (sentAt + rtt / 2) });
    if (this.offsets.length > OFFSET_WINDOW) this.offsets.shift();
  }

  private onClosed(code: number): void {
    this.closed = true;
    this.closeCode = code;
    this.helloWaiter?.(null);
    this.helloWaiter = null;
    for (const [id, p] of [...this.pending]) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.resolve({ t: 'closed' }, false);
    }
  }
}
