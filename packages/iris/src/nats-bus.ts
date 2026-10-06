import {
  AckPolicy,
  DeliverPolicy,
  jetstream,
  jetstreamManager,
  type ConsumerMessages,
  type JetStreamClient,
  type JetStreamManager,
} from '@nats-io/jetstream';
import { connect, nanos, type NatsConnection } from '@nats-io/transport-node';
import { subjectMatches, type Bus, type BusHandler, type BusSubscription, type ConsumeHandler, type ConsumeSpec } from '@apeiron/logos';

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

/** How long a delivered message may stay unacked before JetStream redelivers it. */
const ACK_WAIT_MS = 30_000;
const MAX_ACK_PENDING = 20_000;

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
    // Order traffic gets a JetStream ack; price ticks are fire-and-forget (the PRICES stream still stores them).
    if (subjectMatches('orders.*', subject)) {
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
    const config = {
      durable_name: spec.durable,
      filter_subject: spec.subject,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      ack_wait: nanos(ACK_WAIT_MS),
      max_ack_pending: MAX_ACK_PENDING,
    };
    try {
      await jsm.consumers.info(spec.stream, spec.durable);
      await jsm.consumers.update(spec.stream, spec.durable, {
        ack_wait: config.ack_wait,
        max_ack_pending: config.max_ack_pending,
      });
    } catch {
      await jsm.consumers.add(spec.stream, config);
    }
    const consumer = await this.js.consumers.get(spec.stream, spec.durable);
    const messages: ConsumerMessages = await consumer.consume({ max_messages: 1_000 });
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

  async close(): Promise<void> {
    await this.connection.drain();
  }
}
