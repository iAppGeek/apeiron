import type { CodecName } from '@apeiron/logos';
import { SampleSet } from './stats.js';

export type Direction = 'in' | 'out';

/** Where clients and the special behaviours report what they measure. `at` is the run clock in ms (epoch). */
export type Recorder = {
  rows(info: { codec: CodecName; cold: boolean; at: number; ms: number; serverMs: number }): void;
  delta(info: { codec: CodecName; at: number; ms: number }): void;
  command(info: { codec: CodecName; at: number; ms: number; ok: boolean; code?: string }): void;
  frame(info: { codec: CodecName; direction: Direction; type: string; bytes: number }): void;
  error(info: { codec: CodecName; code: string; at: number }): void;
  sendLag(at: number, ms: number): void;
  count(name: Counter): void;
  event(name: string, at: number, detail?: Record<string, unknown>): void;
};

export type Counter = 'scrolls' | 'viewChanges' | 'commandsSent' | 'commandsSkipped' | 'unexpectedCloses' | 'connectFailures';

export type FrameTotals = { msgs: number; bytes: number };
export type RunEvent = { t: number; name: string; detail: Record<string, unknown> };

export type CodecSamples = {
  rowsCold: SampleSet;
  rowsWarm: SampleSet;
  /** Server-reported `ms` of the same responses, cold and warm apart. */
  serverRowsCold: SampleSet;
  serverRowsWarm: SampleSet;
  delta: SampleSet;
  commandAck: SampleSet;
};

/** Collects everything the clients measure during a run, keyed by codec. Times are stored relative to the run start. */
export class RunRecorder implements Recorder {
  private readonly samples = new Map<CodecName, CodecSamples>();
  private readonly frames = new Map<string, FrameTotals>();
  private readonly errors = new Map<string, number>();
  readonly counters: Record<Counter, number> = { scrolls: 0, viewChanges: 0, commandsSent: 0, commandsSkipped: 0, unexpectedCloses: 0, connectFailures: 0 };
  readonly commandRejects = new Map<string, number>();
  readonly events: RunEvent[] = [];
  readonly sendLags = new SampleSet();

  constructor(readonly startMs: number) {}

  forCodec(codec: CodecName): CodecSamples {
    let s = this.samples.get(codec);
    if (s === undefined) {
      s = { rowsCold: new SampleSet(), rowsWarm: new SampleSet(), serverRowsCold: new SampleSet(), serverRowsWarm: new SampleSet(), delta: new SampleSet(), commandAck: new SampleSet() };
      this.samples.set(codec, s);
    }
    return s;
  }

  codecs(): CodecName[] {
    return [...this.samples.keys()].sort();
  }

  rows(info: { codec: CodecName; cold: boolean; at: number; ms: number; serverMs: number }): void {
    const s = this.forCodec(info.codec);
    const t = info.at - this.startMs;
    (info.cold ? s.rowsCold : s.rowsWarm).add(t, info.ms);
    (info.cold ? s.serverRowsCold : s.serverRowsWarm).add(t, info.serverMs);
  }

  delta(info: { codec: CodecName; at: number; ms: number }): void {
    this.forCodec(info.codec).delta.add(info.at - this.startMs, info.ms);
  }

  command(info: { codec: CodecName; at: number; ms: number; ok: boolean; code?: string }): void {
    if (info.ok) {
      this.forCodec(info.codec).commandAck.add(info.at - this.startMs, info.ms);
    } else {
      const code = info.code ?? 'UNKNOWN';
      this.commandRejects.set(code, (this.commandRejects.get(code) ?? 0) + 1);
    }
  }

  frame(info: { codec: CodecName; direction: Direction; type: string; bytes: number }): void {
    const key = `${info.codec}|${info.direction}|${info.type}`;
    const totals = this.frames.get(key) ?? { msgs: 0, bytes: 0 };
    totals.msgs++;
    totals.bytes += info.bytes;
    this.frames.set(key, totals);
  }

  error(info: { codec: CodecName; code: string; at: number }): void {
    const key = `${info.codec}|${info.code}`;
    this.errors.set(key, (this.errors.get(key) ?? 0) + 1);
  }

  sendLag(at: number, ms: number): void {
    this.sendLags.add(at - this.startMs, ms);
  }

  count(name: Counter): void {
    this.counters[name]++;
  }

  event(name: string, at: number, detail: Record<string, unknown> = {}): void {
    this.events.push({ t: at - this.startMs, name, detail });
  }

  /** Message and byte totals for a codec and direction, and each protocol message type. */
  frameTotals(codec: CodecName, direction: Direction): { total: FrameTotals; byType: Record<string, FrameTotals> } {
    const total = { msgs: 0, bytes: 0 };
    const byType: Record<string, FrameTotals> = {};
    for (const [key, v] of this.frames) {
      const [c, d, type] = key.split('|') as [string, string, string];
      if (c !== codec || d !== direction) continue;
      total.msgs += v.msgs;
      total.bytes += v.bytes;
      byType[type] = { ...v };
    }
    return { total, byType };
  }

  errorCounts(codec: CodecName): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, n] of this.errors) {
      const [c, code] = key.split('|') as [string, string];
      if (c === codec) out[code] = n;
    }
    return out;
  }
}
