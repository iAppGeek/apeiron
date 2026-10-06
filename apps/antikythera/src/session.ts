import {
  COLUMNS_VERSION,
  TRADERS,
  getCodec,
  jsonCodec,
  parseClientMsg,
  type ClientMsg,
  type Codec,
  type ServerMsg,
  type TraderInfo,
} from '@apeiron/logos';
import type { QueryEngine, RowsResult } from './query/engine.js';
import type { Connection, ConnectionHandlers, Frame } from './transport.js';

export type SessionLogger = {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
};

export type SessionDeps = {
  /** Null until the store has finished loading. */
  engine: () => QueryEngine | null;
  log: SessionLogger;
  traders?: readonly TraderInfo[];
  now?: () => number;
  /** Called after every successful getRows (used to log slow cold builds). */
  onRows?: (info: Pick<RowsResult, 'ms' | 'built' | 'rowCount'>) => void;
};

const round = (ms: number): number => Math.round(ms * 100) / 100;

function reqIdOf(input: unknown): number | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const id = (input as { reqId?: unknown }).reqId;
  return typeof id === 'number' && Number.isInteger(id) && id >= 0 ? id : undefined;
}

/**
 * One client connection speaking the Appendix C protocol. The first frame must be a JSON `hello`; every
 * later frame uses the negotiated codec. Nothing a client sends can throw out of `handleFrame`.
 */
export class ClientSession {
  private codec: Codec = jsonCodec;
  private helloDone = false;
  private traderId = 'ALL';
  private clientId = '';
  private closed = false;
  private readonly traders: readonly TraderInfo[];
  private readonly now: () => number;

  constructor(
    private readonly connection: Connection,
    private readonly deps: SessionDeps,
  ) {
    this.traders = deps.traders ?? TRADERS;
    this.now = deps.now ?? ((): number => Date.now());
  }

  get trader(): string {
    return this.traderId;
  }

  get codecName(): string {
    return this.codec.name;
  }

  get id(): string {
    return this.clientId;
  }

  handlers(): ConnectionHandlers {
    return { onFrame: (f) => this.handleFrame(f), onClose: () => this.dispose() };
  }

  dispose(): void {
    this.closed = true;
  }

  handleFrame(frame: Frame): void {
    if (this.closed) return;
    try {
      this.process(frame);
    } catch (error) {
      this.deps.log.error({ err: error, clientId: this.clientId }, 'unhandled error processing frame');
      this.sendError(undefined, 'INTERNAL', 'Internal server error');
    }
  }

  private process(frame: Frame): void {
    let decoded: unknown;
    try {
      if (!this.helloDone) {
        if (typeof frame !== 'string') {
          this.sendError(undefined, 'BAD_FRAME', 'The first frame must be a JSON text hello');
          return;
        }
        decoded = jsonCodec.decode(frame);
      } else {
        decoded = this.codec.decode(frame);
      }
    } catch {
      this.sendError(undefined, 'BAD_FRAME', `Frame is not valid ${this.helloDone ? this.codec.name : 'json'}`);
      return;
    }

    const parsed = parseClientMsg(decoded);
    if (!parsed.ok) {
      this.sendError(reqIdOf(decoded), 'BAD_MESSAGE', parsed.error);
      return;
    }
    this.dispatch(parsed.value);
  }

  private dispatch(msg: ClientMsg): void {
    if (msg.t === 'hello') {
      this.onHello(msg);
      return;
    }
    if (msg.t === 'ping') {
      this.send({ t: 'pong', ts: msg.ts, serverTs: this.now() });
      return;
    }
    if (!this.helloDone) {
      this.sendError('reqId' in msg ? msg.reqId : undefined, 'HELLO_REQUIRED', 'Send hello first');
      return;
    }
    switch (msg.t) {
      case 'getRows':
        this.onGetRows(msg);
        return;
      case 'setFilterValues':
        this.onSetFilterValues(msg);
        return;
      case 'command':
      case 'control':
        this.sendError(msg.reqId, 'NOT_IMPLEMENTED', `${msg.t} is not implemented yet`);
        return;
    }
  }

  private onHello(msg: Extract<ClientMsg, { t: 'hello' }>): void {
    if (msg.traderId !== 'ALL' && !this.traders.some((t) => t.traderId === msg.traderId)) {
      this.sendError(undefined, 'UNKNOWN_TRADER', `Unknown trader: ${msg.traderId}`);
      return;
    }
    this.codec = getCodec(msg.codec);
    this.traderId = msg.traderId;
    this.clientId = msg.clientId;
    this.helloDone = true;
    this.send({
      t: 'welcome',
      serverTime: this.now(),
      traders: [...this.traders],
      columnsVersion: COLUMNS_VERSION,
    });
  }

  private onGetRows(msg: Extract<ClientMsg, { t: 'getRows' }>): void {
    const engine = this.deps.engine();
    if (engine === null) {
      this.sendError(msg.reqId, 'NOT_READY', 'The server is still loading orders');
      return;
    }
    const result = engine.getRows(this.traderId, msg.req);
    if (!result.ok) {
      this.sendError(msg.reqId, result.code, result.message);
      return;
    }
    const { rows, rowCount, ms, built } = result.value;
    this.deps.onRows?.({ ms, built, rowCount });
    this.send({ t: 'rows', reqId: msg.reqId, rows, rowCount, ms: round(ms) });
  }

  private onSetFilterValues(msg: Extract<ClientMsg, { t: 'setFilterValues' }>): void {
    const engine = this.deps.engine();
    if (engine === null) {
      this.sendError(msg.reqId, 'NOT_READY', 'The server is still loading orders');
      return;
    }
    const result = engine.setFilterValues(this.traderId, msg.colId);
    if (!result.ok) {
      this.sendError(msg.reqId, result.code, result.message);
      return;
    }
    this.send({ t: 'filterValues', reqId: msg.reqId, values: result.value });
  }

  private sendError(reqId: number | undefined, code: string, message: string): void {
    this.send(reqId === undefined ? { t: 'error', code, message } : { t: 'error', reqId, code, message });
  }

  private send(msg: ServerMsg): void {
    if (this.closed) return;
    try {
      this.connection.send(this.codec.encode(msg));
    } catch (error) {
      this.deps.log.warn({ err: error, clientId: this.clientId }, 'failed to send frame');
    }
  }
}
