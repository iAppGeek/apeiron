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

  it('answers request/reply, and rejects when the handler throws or nobody serves', async () => {
    const bus = await connect('spec-req');
    await bus.serve(`${subject}.echo`, (p) => ({ echo: p }));
    await bus.serve(`${subject}.boom`, () => {
      throw new Error('boom');
    });
    expect(await bus.request(`${subject}.echo`, { n: 1 }, 2_000)).toEqual({ echo: { n: 1 } });
    await expect(bus.request(`${subject}.boom`, {}, 2_000)).rejects.toThrow('boom');
    await expect(bus.request(`${subject}.nobody`, {}, 500)).rejects.toThrow();
  });

  it('puts, gets and deletes KV values, and reports the value count', async () => {
    const bus = await connect('spec-kv');
    const kv = bus.kv(`KVT_${suffix}`);
    await kv.ensure({ history: 1, storage: 'memory' });
    const r1 = await kv.put('a', { n: 1 });
    const r2 = await kv.put('a', { n: 2 });
    expect(r2).toBeGreaterThan(r1);
    expect(await kv.get('a')).toMatchObject({ key: 'a', value: { n: 2 }, revision: r2, op: 'PUT' });
    expect(await kv.get('missing')).toBeNull();
    expect((await kv.status()).values).toBe(1);
    await kv.delete('a');
    expect(await kv.get('a')).toBeNull();
  });

  it('watches a bucket: initial values end at delta 0, then updates arrive with isUpdate', async () => {
    const bus = await connect('spec-watch');
    const kv = bus.kv(`KVW_${suffix}`);
    await kv.ensure({ history: 1, storage: 'memory' });
    for (let i = 0; i < 5; i++) await kv.put(`k${i}`, { i });
    const watch = await kv.watch();
    const initial: string[] = [];
    const updates: string[] = [];
    let initialDone = false;
    const done = (async (): Promise<void> => {
      for await (const e of watch) {
        if (!e.isUpdate) {
          initial.push(e.key);
          if (e.delta === 0) {
            initialDone = true;
            await kv.put('late', { i: 99 });
          }
        } else {
          updates.push(e.key);
          if (updates.length === 1) break;
        }
      }
    })();
    await done;
    await watch.close();
    expect(initialDone).toBe(true);
    expect(initial.sort()).toEqual(['k0', 'k1', 'k2', 'k3', 'k4']);
    expect(updates).toEqual(['late']);
  });

  it('watches with updatesOnly: existing values are skipped', async () => {
    const bus = await connect('spec-watch-upd');
    const kv = bus.kv(`KVU_${suffix}`);
    await kv.ensure({ history: 1, storage: 'memory' });
    await kv.put('old', 1);
    const watch = await kv.watch({ updatesOnly: true });
    const first = (async (): Promise<string | null> => {
      for await (const e of watch) return `${e.key}:${String(e.isUpdate)}`;
      return null;
    })();
    await kv.put('new', 2);
    expect(await first).toBe('new:true');
    await watch.close();
  });

  it('counts the initial values of a 100k-key bucket exactly using delta === 0, then receives live updates', async () => {
    const bus = await connect('spec-100k');
    const kv = bus.kv(`KV100K_${suffix}`);
    await kv.ensure({ history: 1, storage: 'memory' });
    const total = 100_000;
    const batch = 1_000;
    for (let start = 0; start < total; start += batch) {
      await Promise.all(Array.from({ length: batch }, (_v, i) => kv.put(`ALG${String(start + i).padStart(8, '0')}`, { v: 1 })));
    }
    expect((await kv.status()).values).toBe(total);
    const watch = await kv.watch();
    let loaded = 0;
    let live: string | null = null;
    for await (const e of watch) {
      if (!e.isUpdate) {
        loaded++;
        if (e.delta === 0) await kv.put('LIVE0001', { v: 2 });
      } else {
        live = e.key;
        break;
      }
    }
    await watch.close();
    expect(loaded).toBe(total);
    expect(live).toBe('LIVE0001');
  }, 120_000);

  it('returns the last message per subject of a stream', async () => {
    const bus = await connect('spec-last');
    const jsm = await bus.manager();
    const name = `LAST_${suffix}`;
    await jsm.streams.add({ name, subjects: [`last.${suffix}.*`], max_msgs_per_subject: 1 });
    try {
      const js = bus.connection;
      js.publish(`last.${suffix}.A`, JSON.stringify({ n: 1 }));
      js.publish(`last.${suffix}.B`, JSON.stringify({ n: 2 }));
      js.publish(`last.${suffix}.A`, JSON.stringify({ n: 3 }));
      await js.flush();
      await new Promise((r) => setTimeout(r, 100));
      const last = await bus.lastPerSubject(name, `last.${suffix}.*`);
      expect(last.sort((a, b) => a.subject.localeCompare(b.subject))).toEqual([
        { subject: `last.${suffix}.A`, payload: { n: 3 } },
        { subject: `last.${suffix}.B`, payload: { n: 2 } },
      ]);
      expect(await bus.lastPerSubject(name, `last.${suffix}.Z`)).toEqual([]);
    } finally {
      await jsm.streams.delete(name).catch(() => undefined);
    }
  });
});
