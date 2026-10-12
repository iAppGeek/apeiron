import {
  jetstream,
  jetstreamManager,
  StorageType,
  type ConsumerMessages,
  type JetStreamClient,
  type JetStreamManager,
} from '@nats-io/jetstream';
import { Kvm, KvWatchInclude, type KV } from '@nats-io/kv';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import {
  subjectMatches,
  type Bus,
  type BusHandler,
  type BusSubscription,
  type ConsumeHandler,
  type ConsumeSpec,
  type KvBucket,
  type KvConfig,
  type KvEntry,
  type KvWatch,
  type KvWatchOptions,
  type RequestHandler,
  type StoredMessage,
} from '@apeiron/logos';
import { ensureConsumer } from './consumers.js';

export type BusLogger = {
  warn(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
};

export type NatsBusOptions = {
  url: string;
  /** Connection name shown in the NATS monitor. */
  name: string;
  log?: BusLogger;
};

const decoder = new TextDecoder();

/** Subjects published through JetStream so the caller learns the stream stored them. */
const ACKED_SUBJECTS = ['orders.*', 'exec.*'];

/** Marks a reply that carries a handler error, so `request` can reject with it. */
const ERROR_KEY = '__busError';

/** Messages a consumer pulls at a time: a bounded batch, so a stalled loop never has a huge backlog in flight. */
export const CONSUME_BATCH = 500;

/** The Bus over NATS core plus JetStream. Subjects captured by a stream are published through JetStream. */
export class NatsBus implements Bus {
  private readonly js: JetStreamClient;
  private jsmPromise: Promise<JetStreamManager> | null = null;

  private constructor(
    readonly connection: NatsConnection,
    private readonly log: BusLogger | undefined,
  ) {
    this.js = jetstream(connection);
  }

  static async connect(options: NatsBusOptions): Promise<NatsBus> {
    const nc = await connect({
      servers: options.url,
      name: options.name,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 500,
    });
    return new NatsBus(nc, options.log);
  }

  manager(): Promise<JetStreamManager> {
    this.jsmPromise ??= jetstreamManager(this.connection);
    return this.jsmPromise;
  }

  async publish(subject: string, payload: unknown): Promise<void> {
    const data = JSON.stringify(payload);
    // Order and execution traffic gets a JetStream ack; price ticks are fire-and-forget (the PRICES stream still stores them).
    if (ACKED_SUBJECTS.some((pattern) => subjectMatches(pattern, subject))) {
      await this.js.publish(subject, data);
      return;
    }
    this.connection.publish(subject, data);
  }

  subscribe(subject: string, handler: BusHandler): Promise<BusSubscription> {
    const sub = this.connection.subscribe(subject, {
      callback: (err, msg) => {
        if (err !== null) {
          this.log?.warn({ err, subject }, 'subscription error');
          return;
        }
        try {
          handler(JSON.parse(decoder.decode(msg.data)) as unknown, msg.subject);
        } catch (error) {
          this.log?.warn({ err: error, subject: msg.subject }, 'dropped undecodable message');
        }
      },
    });
    return Promise.resolve({
      close: (): Promise<void> => {
        sub.unsubscribe();
        return Promise.resolve();
      },
    });
  }

  async consume(spec: ConsumeSpec, handler: ConsumeHandler): Promise<BusSubscription> {
    const jsm = await this.manager();
    await ensureConsumer(jsm, spec);
    const consumer = await this.js.consumers.get(spec.stream, spec.durable);
    const messages: ConsumerMessages = await consumer.consume({ max_messages: CONSUME_BATCH });
    void (async (): Promise<void> => {
      for await (const m of messages) {
        let payload: unknown;
        try {
          payload = JSON.parse(decoder.decode(m.data)) as unknown;
        } catch (error) {
          this.log?.warn({ err: error, subject: m.subject }, 'dropped undecodable message');
          m.ack();
          continue;
        }
        handler(payload, m.subject, () => m.ack());
      }
    })().catch((error: unknown) => this.log?.warn({ err: error }, 'consumer loop ended'));
    return {
      close: async (): Promise<void> => {
        await messages.close();
      },
    };
  }

  async request(subject: string, payload: unknown, timeoutMs: number): Promise<unknown> {
    const msg = await this.connection.request(subject, JSON.stringify(payload), { timeout: timeoutMs });
    const reply = JSON.parse(decoder.decode(msg.data)) as unknown;
    if (typeof reply === 'object' && reply !== null && ERROR_KEY in reply) {
      throw new Error(String((reply as Record<string, unknown>)[ERROR_KEY]));
    }
    return reply;
  }

  serve(subject: string, handler: RequestHandler): Promise<BusSubscription> {
    const respond = (msg: { respond(data: string): boolean }, body: unknown): void => {
      msg.respond(JSON.stringify(body === undefined ? null : body));
    };
    const sub = this.connection.subscribe(subject, {
      callback: (err, msg) => {
        if (err !== null) {
          this.log?.warn({ err, subject }, 'serve error');
          return;
        }
        void (async (): Promise<void> => {
          try {
            const payload = JSON.parse(decoder.decode(msg.data)) as unknown;
            respond(msg, await handler(payload, msg.subject));
          } catch (error) {
            respond(msg, { [ERROR_KEY]: error instanceof Error ? error.message : String(error) });
          }
        })();
      },
    });
    return Promise.resolve({
      close: (): Promise<void> => {
        sub.unsubscribe();
        return Promise.resolve();
      },
    });
  }

  async lastPerSubject(stream: string, filter: string): Promise<StoredMessage[]> {
    const jsm = await this.manager();
    const info = await jsm.streams.info(stream, { subjects_filter: filter });
    const out: StoredMessage[] = [];
    for (const subject of Object.keys(info.state.subjects ?? {})) {
      const stored = await jsm.streams.getMessage(stream, { last_by_subj: subject });
      if (stored !== null) out.push({ subject: stored.subject, payload: JSON.parse(decoder.decode(stored.data)) as unknown });
    }
    return out;
  }

  kv(bucket: string): KvBucket {
    return new NatsKvBucket(bucket, new Kvm(this.js), this.log);
  }

  async close(): Promise<void> {
    await this.connection.drain();
  }
}

const decodeValue = (data: Uint8Array, log: BusLogger | undefined, key: string): unknown => {
  try {
    return JSON.parse(decoder.decode(data)) as unknown;
  } catch (error) {
    log?.warn({ err: error, key }, 'undecodable KV value');
    return undefined;
  }
};

/** A JetStream KV bucket (`@nats-io/kv`) with JSON values. */
class NatsKvBucket implements KvBucket {
  private kv: KV | null = null;

  constructor(
    private readonly name: string,
    private readonly kvm: Kvm,
    private readonly log: BusLogger | undefined,
  ) {}

  private async handle(): Promise<KV> {
    this.kv ??= await this.kvm.open(this.name);
    return this.kv;
  }

  async ensure(config: KvConfig): Promise<void> {
    this.kv = await this.kvm.create(this.name, {
      history: config.history,
      storage: config.storage === 'file' ? StorageType.File : StorageType.Memory,
      ...(config.maxValueSize === undefined ? {} : { maxValueSize: config.maxValueSize }),
      ...(config.maxBytes === undefined ? {} : { max_bytes: config.maxBytes }),
      ...(config.replicas === undefined ? {} : { replicas: config.replicas }),
    });
  }

  async put(key: string, value: unknown): Promise<number> {
    return (await this.handle()).put(key, JSON.stringify(value));
  }

  async delete(key: string): Promise<void> {
    await (await this.handle()).delete(key);
  }

  async get(key: string): Promise<KvEntry | null> {
    const e = await (await this.handle()).get(key);
    if (e === null || e.operation !== 'PUT') return null;
    return { key, value: decodeValue(e.value, this.log, key), revision: e.revision, op: 'PUT', isUpdate: true, delta: 0 };
  }

  async status(): Promise<{ values: number }> {
    return { values: (await (await this.handle()).status()).values };
  }

  async watch(options: KvWatchOptions = {}): Promise<KvWatch> {
    const updatesOnly = options.updatesOnly === true;
    const kv = await this.handle();
    const watch = await kv.watch(updatesOnly ? { include: KvWatchInclude.UpdatesOnly } : {});
    const log = this.log;
    return {
      close: (): Promise<void> => {
        watch.stop();
        return Promise.resolve();
      },
      async *[Symbol.asyncIterator](): AsyncGenerator<KvEntry> {
        for await (const e of watch) {
          yield {
            key: e.key,
            value: e.operation === 'PUT' ? decodeValue(e.value, log, e.key) : null,
            revision: e.revision,
            op: e.operation,
            isUpdate: updatesOnly || e.isUpdate,
            delta: e.delta ?? 0,
          };
        }
      },
    };
  }
}
