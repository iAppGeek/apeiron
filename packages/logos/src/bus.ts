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
  close(): Promise<void>;
};
