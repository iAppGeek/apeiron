/** A decoded message payload. Producers send JSON-serialisable values; consumers validate with zod. */
export type BusHandler = (payload: unknown, subject: string) => void;

/** Handler for a durable stream consumer. Call `ack` once the message is safely applied (and persisted). */
export type ConsumeHandler = (payload: unknown, subject: string, ack: () => void) => void;

export type BusSubscription = { close(): Promise<void> };

export type ConsumeSpec = { stream: string; durable: string; subject: string };

/**
 * The small messaging surface the server and the mock middleware need. NATS implements it for real
 * (`@apeiron/iris`); {@link MemoryBus} implements it for unit tests.
 */
export type Bus = {
  /** Publishes to a subject. Subjects covered by a stream are stored there. */
  publish(subject: string, payload: unknown): Promise<void>;
  /** Plain (non-durable) subscription; `*` matches one token and `>` the rest. */
  subscribe(subject: string, handler: BusHandler): Promise<BusSubscription>;
  /** Durable consumer: redelivers unacknowledged messages after a restart. */
  consume(spec: ConsumeSpec, handler: ConsumeHandler): Promise<BusSubscription>;
  /** Request/reply. Rejects on timeout, when nobody serves the subject, or when the handler throws. */
  request(subject: string, payload: unknown, timeoutMs: number): Promise<unknown>;
  /** Serves request/reply on a subject. */
  serve(subject: string, handler: RequestHandler): Promise<BusSubscription>;
  /** A JetStream key-value bucket. Cheap to call; nothing is created until `ensure`. */
  kv(bucket: string): KvBucket;
  /** The latest message for every subject in the stream that matches `filter`, in no particular order. */
  lastPerSubject(stream: string, filter: string): Promise<StoredMessage[]>;
  close(): Promise<void>;
};

/** Answers a request. Return the reply payload; throwing (or rejecting) fails the caller's `request`. */
export type RequestHandler = (payload: unknown, subject: string) => unknown;

export type KvOperation = 'PUT' | 'DEL' | 'PURGE';

/**
 * One KV entry. `revision` is the bucket's sequence number: use it to order and resume, but compare your own
 * per-record version to decide staleness. `isUpdate` is false for the values that existed when a watch opened
 * and true for changes after that. `delta` is how many entries are still pending behind this one, so the last
 * initial value has `delta === 0`. `value` is null for `DEL` and `PURGE`.
 */
export type KvEntry = {
  key: string;
  value: unknown;
  revision: number;
  op: KvOperation;
  isUpdate: boolean;
  delta: number;
};

export type KvConfig = {
  /** Versions kept per key. */
  history: number;
  storage: 'file' | 'memory';
  /** Bytes. Omit for the server default. */
  maxValueSize?: number;
  /** Bytes. Omit for unlimited. */
  maxBytes?: number;
  replicas?: number;
};

export type KvWatchOptions = {
  /** Skip the values that already exist and deliver only later changes (`isUpdate` is then always true). */
  updatesOnly?: boolean;
};

/** Iterate for entries; `close()` ends the iteration. An empty bucket yields nothing until something changes. */
export type KvWatch = AsyncIterable<KvEntry> & { close(): Promise<void> };

export type KvBucket = {
  /** Creates the bucket when missing. An existing bucket is left as it is. */
  ensure(config: KvConfig): Promise<void>;
  /** Stores a JSON-serialisable value and returns its revision. */
  put(key: string, value: unknown): Promise<number>;
  /** The latest entry for a key, or null when absent. */
  get(key: string): Promise<KvEntry | null>;
  /** Writes a delete marker (watchers see `op: 'DEL'`). */
  delete(key: string): Promise<void>;
  /** The number of entries (keys, including delete markers) in the bucket. */
  status(): Promise<{ values: number }>;
  watch(options?: KvWatchOptions): Promise<KvWatch>;
};

/** The last message a stream holds for one subject. */
export type StoredMessage = { subject: string; payload: unknown };
