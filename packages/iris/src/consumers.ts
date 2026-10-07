import { AckPolicy, DeliverPolicy } from '@nats-io/jetstream';
import { nanos } from '@nats-io/transport-node';

/** How long a delivered message may stay unacked before JetStream redelivers it. */
export const ACK_WAIT_MS = 30_000;
export const MAX_ACK_PENDING = 20_000;

export type DurableConsumerSpec = { stream: string; durable: string; subject: string };

/**
 * A durable consumer with `AckPolicy.All`: acknowledging one message acknowledges everything before it, so a
 * batch is acknowledged by its last message and a crash can never leave a gap.
 */
export function durableConsumerConfig(spec: DurableConsumerSpec): {
  durable_name: string;
  filter_subject: string;
  ack_policy: AckPolicy;
  deliver_policy: DeliverPolicy;
  ack_wait: number;
  max_ack_pending: number;
} {
  return {
    durable_name: spec.durable,
    filter_subject: spec.subject,
    ack_policy: AckPolicy.All,
    deliver_policy: DeliverPolicy.All,
    ack_wait: nanos(ACK_WAIT_MS),
    max_ack_pending: MAX_ACK_PENDING,
  };
}

/** The part of the JetStream manager `ensureConsumer` needs, so it can be tested without a server. */
export type ConsumerManager = {
  consumers: {
    info(stream: string, durable: string): Promise<{ config: { ack_policy?: AckPolicy } }>;
    add(stream: string, config: ReturnType<typeof durableConsumerConfig>): Promise<unknown>;
    update(stream: string, durable: string, config: { ack_wait: number; max_ack_pending: number }): Promise<unknown>;
    delete(stream: string, durable: string): Promise<unknown>;
    reset(stream: string, durable: string): Promise<unknown>;
  };
};

export type EnsureConsumerResult = 'created' | 'updated' | 'recreated';

/**
 * Creates the durable consumer, or brings an existing one in line. A consumer made with a different ack
 * policy cannot be edited, so it is deleted and recreated (it then replays from the start of the stream, which
 * is safe because events are absolute). An existing consumer is also reset (server 2.14+): messages that were
 * delivered but never acknowledged before a crash would otherwise wait out `ack_wait` before coming back, and
 * a restarting server wants them at once. The ack floor is kept, so nothing acknowledged is replayed.
 */
export async function ensureConsumer(manager: ConsumerManager, spec: DurableConsumerSpec): Promise<EnsureConsumerResult> {
  const config = durableConsumerConfig(spec);
  let existing: { config: { ack_policy?: AckPolicy } } | null;
  try {
    existing = await manager.consumers.info(spec.stream, spec.durable);
  } catch {
    existing = null;
  }
  if (existing === null) {
    await manager.consumers.add(spec.stream, config);
    return 'created';
  }
  if (existing.config.ack_policy !== AckPolicy.All) {
    await manager.consumers.delete(spec.stream, spec.durable);
    await manager.consumers.add(spec.stream, config);
    return 'recreated';
  }
  await manager.consumers.update(spec.stream, spec.durable, { ack_wait: config.ack_wait, max_ack_pending: config.max_ack_pending });
  await manager.consumers.reset(spec.stream, spec.durable);
  return 'updated';
}
