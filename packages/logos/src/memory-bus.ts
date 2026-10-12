import type {
  Bus,
  BusHandler,
  BusSubscription,
  ConsumeHandler,
  ConsumeSpec,
  KvBucket,
  KvConfig,
  KvEntry,
  KvWatch,
  KvWatchOptions,
  RequestHandler,
  StoredMessage,
} from './bus.js';

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

/** A queue that is also an async iterable; `end()` finishes the iteration once the queue drains. */
class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiting: ((r: IteratorResult<T>) => void) | null = null;
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    if (this.waiting !== null) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: item, done: false });
    } else this.items.push(item);
  }

  end(): void {
    this.ended = true;
    if (this.waiting !== null) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

/** Runs `fn` and returns its result as a promise, turning a throw into a rejection. */
function run<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

type KvWatcher = { queue: AsyncQueue<KvEntry> };

/** One in-memory bucket: the latest entry per key, a bucket-wide revision counter, and the open watches. */
class MemoryKvState {
  readonly entries = new Map<string, KvEntry>();
  readonly watchers = new Set<KvWatcher>();
  revision = 0;
}

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
  private readonly servers = new Map<string, RequestHandler>();
  private readonly buckets = new Map<string, MemoryKvState>();

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

  async request(subject: string, payload: unknown, timeoutMs: number): Promise<unknown> {
    const handler = [...this.servers].find(([pattern]) => subjectMatches(pattern, subject))?.[1];
    if (handler === undefined) throw new Error(`No responders for ${subject}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Request to ${subject} timed out after ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      return clone(await Promise.race([Promise.resolve().then(() => handler(clone(payload), subject)), timeout]));
    } finally {
      clearTimeout(timer);
    }
  }

  serve(subject: string, handler: RequestHandler): Promise<BusSubscription> {
    this.servers.set(subject, handler);
    return Promise.resolve({
      close: (): Promise<void> => {
        if (this.servers.get(subject) === handler) this.servers.delete(subject);
        return Promise.resolve();
      },
    });
  }

  lastPerSubject(stream: string, filter: string): Promise<StoredMessage[]> {
    const state = this.streams.get(stream);
    if (state === undefined) return Promise.reject(new Error(`Unknown stream ${stream}`));
    const last = new Map<string, unknown>();
    for (const m of state.log) if (subjectMatches(filter, m.subject)) last.set(m.subject, m.payload);
    return Promise.resolve([...last].map(([subject, payload]): StoredMessage => ({ subject, payload: clone(payload) })));
  }

  kv(bucket: string): KvBucket {
    const state = (): MemoryKvState => {
      const s = this.buckets.get(bucket);
      if (s === undefined) throw new Error(`KV bucket ${bucket} not found`);
      return s;
    };
    return {
      ensure: (_config: KvConfig): Promise<void> =>
        run(() => {
          if (!this.buckets.has(bucket)) this.buckets.set(bucket, new MemoryKvState());
        }),
      put: (key, value) =>
        run(() => {
          const s = state();
          const entry: KvEntry = { key, value: clone(value), revision: ++s.revision, op: 'PUT', isUpdate: true, delta: 0 };
          s.entries.set(key, entry);
          for (const w of s.watchers) w.queue.push(clone(entry));
          return entry.revision;
        }),
      delete: (key) =>
        run(() => {
          const s = state();
          if (!s.entries.has(key)) return;
          const entry: KvEntry = { key, value: null, revision: ++s.revision, op: 'DEL', isUpdate: true, delta: 0 };
          s.entries.set(key, entry);
          for (const w of s.watchers) w.queue.push(clone(entry));
        }),
      get: (key) =>
        run(() => {
          const entry = state().entries.get(key);
          return entry === undefined || entry.op !== 'PUT' ? null : { ...clone(entry), isUpdate: true, delta: 0 };
        }),
      status: () => run(() => ({ values: state().entries.size })),
      watch: (options: KvWatchOptions = {}) =>
        run(() => {
          const s = state();
          const queue = new AsyncQueue<KvEntry>();
          const initial = options.updatesOnly === true ? [] : [...s.entries.values()].sort((a, b) => a.revision - b.revision);
          initial.forEach((entry, i) => queue.push({ ...clone(entry), isUpdate: false, delta: initial.length - 1 - i }));
          const watcher: KvWatcher = { queue };
          s.watchers.add(watcher);
          const watch: KvWatch = {
            [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
            close: (): Promise<void> => {
              s.watchers.delete(watcher);
              queue.end();
              return Promise.resolve();
            },
          };
          return watch;
        }),
    };
  }

  close(): Promise<void> {
    this.subs.clear();
    this.consumers.clear();
    this.servers.clear();
    for (const s of this.buckets.values()) for (const w of s.watchers) w.queue.end();
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
