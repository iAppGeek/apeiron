import {
  COLUMNS_VERSION,
  TRADERS,
  getCodec,
  jsonCodec,
  msgpackCodec,
  parseClientMsg,
  type ClientMsg,
  type CommandAction,
  type Codec,
  type ErrorCode,
  type LoadPreset,
  type ServerMsg,
  type TraderInfo,
} from '@apeiron/logos';
import type { ChangeSet } from './query/changeset.js';
import type { ColumnarStore } from './store/columnar-store.js';
import type { QueryEngine, RowsResult } from './query/engine.js';
import type { View, ViewChanges } from './query/view.js';
import type { CommandOutcome } from './live/commands.js';
import { BackpressureGate, type BackpressureOptions } from './live/backpressure.js';
import type { StatusSummary } from './live/counters.js';
import type { ServerStats } from './live/system-stats.js';
import { ClientTracker } from './live/tracker.js';
import type { Connection, ConnectionHandlers, Frame } from './transport.js';

export type SessionLogger = {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
};

/** What a live session needs from the runtime: registration for flush ticks, the load control, and summary data. */
export type LiveHooks = {
  register(session: ClientSession): void;
  unregister(session: ClientSession): void;
  setPreset(preset: LoadPreset): Promise<void>;
  /** Pre-checks and publishes a command; `settle` is called once with how it ended. */
  command(request: CommandRequest, settle: (outcome: CommandOutcome) => void): void;
  /** The preset hermes last reported on `control.state`, or null before it has. */
  preset(): LoadPreset | null;
  summary(traderId: string): StatusSummary;
  stats(): ServerStats;
  maxTrackedBlocks: number;
  backpressure: BackpressureOptions;
  summaryIntervalMs: number;
};

/** A trader command on its way to hermes. `owner` ties it to the session so it is forgotten when that closes. */
export type CommandRequest = { owner: object; clientId: string; reqId: number; orderId: string; action: CommandAction };

/** One flush tick as seen by a session. */
export type FlushContext = { cs: ChangeSet; byView: ReadonlyMap<View, ViewChanges>; now: number; store: ColumnarStore };

export type SessionDeps = {
  /** Null (or returning null) until the store is loaded and the live runtime is up. */
  live?: () => LiveHooks | null;
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
 * later frame is decoded by its type (text JSON, binary msgpack) and encoded with the negotiated codec. Nothing a client sends can throw out of `handleFrame`.
 */
export class ClientSession {
  private codec: Codec = jsonCodec;
  private helloDone = false;
  private traderId = 'ALL';
  private clientId = '';
  private closed = false;
  private tracker: ClientTracker | null = null;
  private gate: BackpressureGate | null = null;
  private lastSummaryAt = 0;
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
    this.tracker?.dispose();
    this.deps.live?.()?.unregister(this);
  }

  /** The view this client follows, if it has asked for rows. */
  get trackedView(): View | null {
    return this.tracker?.view ?? null;
  }

  /**
   * Called after every flush tick: folds the tick into this client's pending changes, then sends a delta if
   * the socket has room (a held-back client keeps accumulating and gets one conflated delta once it drains),
   * and a summary about once a second. A client that stays too far behind gets SLOW_CONSUMER and is closed.
   */
  onFlush(ctx: FlushContext): void {
    const live = this.deps.live?.();
    if (this.closed || !this.helloDone || live === null || live === undefined) return;
    this.tracker ??= new ClientTracker(live.maxTrackedBlocks);
    this.gate ??= new BackpressureGate(live.backpressure);
    const tracker = this.tracker;
    const view = tracker.view;
    if (view !== null) tracker.collect(ctx.byView.get(view), ctx.cs);

    const decision = this.gate.decide(this.connection.bufferedAmount, ctx.now);
    if (decision === 'close') {
      this.deps.log.warn({ clientId: this.clientId, buffered: this.connection.bufferedAmount }, 'closing slow consumer');
      this.send({ t: 'error', code: 'SLOW_CONSUMER', message: 'The client is too far behind the server' });
      this.connection.close(1013, 'slow consumer');
      this.dispose();
      return;
    }
    if (decision === 'hold') return;
    const delta = tracker.build(ctx.store, ctx.now);
    if (delta !== null) this.send(delta);
    if (ctx.now - this.lastSummaryAt >= live.summaryIntervalMs) {
      this.lastSummaryAt = ctx.now;
      this.sendSummary(live, tracker);
    }
  }

  private sendSummary(live: LiveHooks, tracker: ClientTracker): void {
    const scope = live.summary(this.traderId);
    const totalRows = tracker.view?.filteredCount ?? Object.values(scope.byStatus).reduce((a, b) => a + b, 0);
    this.send({
      t: 'summary',
      byStatus: scope.byStatus,
      liveNotionalUsd: scope.liveNotionalUsd,
      totalRows,
      server: live.stats(),
      preset: live.preset(),
    });
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
        // Frames are self-describing: text is JSON, binary is msgpack, whatever was negotiated.
        decoded = typeof frame === 'string' ? jsonCodec.decode(frame) : msgpackCodec.decode(frame);
      }
    } catch {
      this.sendError(undefined, 'BAD_FRAME', `Frame is not valid ${typeof frame === 'string' || !this.helloDone ? 'json' : 'msgpack'}`);
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
      case 'control':
        this.onControl(msg);
        return;
      case 'command':
        this.onCommand(msg);
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
    this.tracker?.reset();
    this.lastSummaryAt = 0;
    this.deps.live?.()?.register(this);
    this.send({
      t: 'welcome',
      serverTime: this.now(),
      traders: [...this.traders],
      columnsVersion: COLUMNS_VERSION,
      preset: this.deps.live?.()?.preset() ?? null,
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
    const live = this.deps.live?.();
    if (live !== null && live !== undefined) {
      this.tracker ??= new ClientTracker(live.maxTrackedBlocks);
      this.tracker.record(result.value.track);
    }
    this.send({ t: 'rows', reqId: msg.reqId, rows, rowCount, ms: round(ms) });
  }

  private onCommand(msg: Extract<ClientMsg, { t: 'command' }>): void {
    const live = this.deps.live?.();
    if (live === null || live === undefined) {
      this.sendError(msg.reqId, 'NOT_IMPLEMENTED', 'commands are not available without a message bus');
      return;
    }
    live.command(
      { owner: this, clientId: this.clientId, reqId: msg.reqId, orderId: msg.orderId, action: msg.action },
      (outcome) => {
        if (outcome.ok) this.send({ t: 'ack', reqId: msg.reqId });
        else this.sendError(msg.reqId, outcome.code, outcome.message);
      },
    );
  }

  private onControl(msg: Extract<ClientMsg, { t: 'control' }>): void {
    const live = this.deps.live?.();
    if (live === null || live === undefined) {
      this.sendError(msg.reqId, 'NOT_IMPLEMENTED', 'control is not available without a message bus');
      return;
    }
    live.setPreset(msg.preset).then(
      () => this.send({ t: 'ack', reqId: msg.reqId }),
      (error: unknown) => {
        this.deps.log.error({ err: error }, 'failed to publish control.load');
        this.sendError(msg.reqId, 'INTERNAL', 'Could not publish the load preset');
      },
    );
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

  private sendError(reqId: number | undefined, code: ErrorCode, message: string): void {
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
