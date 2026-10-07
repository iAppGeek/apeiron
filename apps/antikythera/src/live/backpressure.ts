export type BackpressureOptions = {
  /** Above this many buffered bytes a client gets no deltas; its changes keep accumulating (conflated). */
  softBytes: number;
  /** Above this the client is closed with SLOW_CONSUMER. */
  hardBytes: number;
  /** Staying above the soft cap this long also closes the client. */
  maxSlowMs: number;
};

export const DEFAULT_BACKPRESSURE: BackpressureOptions = {
  softBytes: 1_048_576,
  hardBytes: 8_388_608,
  maxSlowMs: 15_000,
};

export type GateDecision = 'send' | 'hold' | 'close';

/**
 * Per-client send gate driven by the socket's `bufferedAmount`. Below the soft cap the client is sent
 * deltas; above it deltas are held back (the caller keeps accumulating the latest values and sends one
 * conflated delta once the buffer drains); above the hard cap, or after staying above the soft cap too long,
 * the client is too far behind and must be closed.
 */
export class BackpressureGate {
  private slowSince: number | null = null;

  constructor(private readonly options: BackpressureOptions) {}

  get slow(): boolean {
    return this.slowSince !== null;
  }

  decide(bufferedBytes: number, now: number): GateDecision {
    if (bufferedBytes >= this.options.hardBytes) return 'close';
    if (bufferedBytes >= this.options.softBytes) {
      this.slowSince ??= now;
      return now - this.slowSince >= this.options.maxSlowMs ? 'close' : 'hold';
    }
    this.slowSince = null;
    return 'send';
  }
}
