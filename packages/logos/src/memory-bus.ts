import type { Bus, BusHandler, BusSubscription, ConsumeHandler, ConsumeSpec } from './bus.js';

type StreamState = { subjects: string[]; log: { subject: string; payload: unknown }[] };
/** Everything at or below `ackedThrough` is acknowledged (JetStream's `AckPolicy.All`). */
type DurableState = { ackedThrough: number };
type Sub = { subject: string; handler: BusHandler };
type Consumer = { spec: ConsumeSpec; handler: ConsumeHandler; closed: boolean };

/** Whether a NATS-style subject pattern (`*` one token, `>` the tail) matches a concrete subject. */
export function subjectMatches(pattern: string, subject: string): boolean {
  const p = pattern.split('.');
  const s = subject.split('.');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '>') return s.length > i;
    if (i >= s.length) return false;
    if (p[i] !== '*' && p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}

const clone = <T>(value: T): T => structuredClone(value);

/**
 * In-process {@link Bus} for tests. Delivery is synchronous, payloads are cloned (so tests catch aliasing),
 * and streams keep a log so a durable consumer that reconnects is replayed everything it has not acked.
 * An ack covers every earlier message too, as JetStream's `AckPolicy.All` does.
 */
export class MemoryBus implements Bus {
  private readonly subs = new Set<Sub>();
  private readonly streams = new Map<string, StreamState>();
  private readonly durables = new Map<string, DurableState>();
  private readonly consumers = new Set<Consumer>();

  constructor(streams: Record<string, string[]> = { ORDERS: ['orders.*'], PRICES: ['prices.*'] }) {
    for (const [name, subjects] of Object.entries(streams)) this.streams.set(name, { subjects, log: [] });
  }

  /** Every message stored in a stream, in publish order. */
  streamLog(name: string): { subject: string; payload: unknown }[] {
    return this.streams.get(name)?.log ?? [];
  }

  publish(subject: string, payload: unknown): Promise<void> {
    const data = clone(payload);
    for (const [name, stream] of this.streams) {
      if (!stream.subjects.some((s) => subjectMatches(s, subject))) continue;
      stream.log.push({ subject, payload: data });
      const index = stream.log.length - 1;
      for (const consumer of [...this.consumers]) {
        if (consumer.closed || consumer.spec.stream !== name || !subjectMatches(consumer.spec.subject, subject)) continue;
        this.deliver(consumer, index, subject, data);
      }
    }
    for (const sub of [...this.subs]) {
      if (subjectMatches(sub.subject, subject)) sub.handler(clone(data), subject);
    }
    return Promise.resolve();
  }

  subscribe(subject: string, handler: BusHandler): Promise<BusSubscription> {
    const sub: Sub = { subject, handler };
    this.subs.add(sub);
    return Promise.resolve({
      close: (): Promise<void> => {
        this.subs.delete(sub);
        return Promise.resolve();
      },
    });
  }

  consume(spec: ConsumeSpec, handler: ConsumeHandler): Promise<BusSubscription> {
    const stream = this.streams.get(spec.stream);
    if (stream === undefined) return Promise.reject(new Error(`Unknown stream ${spec.stream}`));
    const durable = this.durable(spec.durable);
    const consumer: Consumer = { spec, handler, closed: false };
    this.consumers.add(consumer);
    stream.log.forEach((m, index) => {
      if (index > durable.ackedThrough && subjectMatches(spec.subject, m.subject)) {
        this.deliver(consumer, index, m.subject, m.payload);
      }
    });
    return Promise.resolve({
      close: (): Promise<void> => {
        consumer.closed = true;
        this.consumers.delete(consumer);
        return Promise.resolve();
      },
    });
  }

  close(): Promise<void> {
    this.subs.clear();
    this.consumers.clear();
    return Promise.resolve();
  }

  private durable(name: string): DurableState {
    let d = this.durables.get(name);
    if (d === undefined) {
      d = { ackedThrough: -1 };
      this.durables.set(name, d);
    }
    return d;
  }

  private deliver(consumer: Consumer, index: number, subject: string, payload: unknown): void {
    const durable = this.durable(consumer.spec.durable);
    consumer.handler(clone(payload), subject, () => {
      durable.ackedThrough = Math.max(durable.ackedThrough, index);
    });
  }
}
