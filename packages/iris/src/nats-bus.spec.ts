import { jetstreamManager } from '@nats-io/jetstream';
import { afterAll, describe, expect, it } from 'vitest';
import { NatsBus } from './nats-bus.js';

const url = process.env.NATS_URL;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const stream = `TEST_${suffix}`;
const subject = `testing.${suffix}`;

const until = async (check: () => boolean, ms = 3_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** Needs a NATS server with JetStream (set NATS_URL, for example the compose stack). Skipped otherwise. */
describe.skipIf(url === undefined)('NatsBus against a real server', () => {
  const buses: NatsBus[] = [];
  const connect = async (name: string): Promise<NatsBus> => {
    const bus = await NatsBus.connect({ url: url as string, name });
    buses.push(bus);
    return bus;
  };

  afterAll(async () => {
    const bus = await NatsBus.connect({ url: url as string, name: 'cleanup' });
    const jsm = await jetstreamManager(bus.connection);
    await jsm.streams.delete(stream).catch(() => undefined);
    await bus.close();
    for (const b of buses) await b.close().catch(() => undefined);
  });

  it('delivers plain subscriptions, including wildcards', async () => {
    const bus = await connect('spec-sub');
    const seen: [unknown, string][] = [];
    await bus.subscribe(`${subject}.*`, (p, s) => seen.push([p, s]));
    await bus.publish(`${subject}.a`, { n: 1 });
    await until(() => seen.length === 1);
    expect(seen[0]).toEqual([{ n: 1 }, `${subject}.a`]);
  });

  it('replays unacknowledged messages to a durable consumer after a reconnect, honouring ack-all', async () => {
    const admin = await connect('spec-admin');
    const jsm = await admin.manager();
    await jsm.streams.add({ name: stream, subjects: [`${subject}.events`] });
    for (const n of [1, 2, 3]) await admin.publish(`${subject}.events`, { n });
    // Core publishes to a stream subject are stored; give the server a moment.
    await new Promise((r) => setTimeout(r, 100));

    const first = await connect('spec-c1');
    const got: number[] = [];
    let ackSecond: (() => void) | null = null;
    const sub = await first.consume({ stream, durable: 'spec', subject: `${subject}.events` }, (p, _s, ack) => {
      const n = (p as { n: number }).n;
      got.push(n);
      if (n === 2) ackSecond = ack;
    });
    await until(() => got.length === 3);
    expect(got).toEqual([1, 2, 3]);
    (ackSecond as (() => void) | null)?.();
    await new Promise((r) => setTimeout(r, 200));
    await sub.close();

    const second = await connect('spec-c2');
    const again: number[] = [];
    await second.consume({ stream, durable: 'spec', subject: `${subject}.events` }, (p, _s, ack) => {
      again.push((p as { n: number }).n);
      ack();
    });
    await until(() => again.length >= 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(again).toEqual([3]);
  });
});
