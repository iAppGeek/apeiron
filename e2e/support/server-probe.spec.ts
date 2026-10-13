import { describe, expect, it, vi } from 'vitest';
import { createServerProbe, parseSnapshot, readCounter } from './server-probe';

const health = (stage = 'ready'): unknown => ({ status: stage === 'ready' ? 'ok' : 'loading', stage, rows: 10, live: { clients: 2, pendingEvents: 0 } });
const lag = (appliedRev: number): unknown => ({ appliedRev, stage: 'ready', flush: { lastMs: 0.3 } });
const jsz = (lastSeq: number, pending: number, ack: number): unknown => ({
  account_details: [
    {
      stream_detail: [
        { name: 'KV_ORDER_STATE', state: { last_seq: lastSeq } },
        { name: 'ORDERS', consumer_detail: [{ name: 'hermes-commands', num_pending: 9, num_ack_pending: 9 }, { name: 'themis-exec', num_pending: pending, num_ack_pending: ack }] },
      ],
    },
  ],
});

describe('parseSnapshot', () => {
  it('reads the stage, the applied revision, the newest published one and the themis-exec consumer only', () => {
    expect(parseSnapshot(health(), lag(41), jsz(42, 3, 4))).toMatchObject({
      status: 'ok',
      stage: 'ready',
      rows: 10,
      clients: 2,
      appliedRev: 41,
      kvLastSeq: 42,
      consumerPending: 3,
      consumerAckPending: 4,
    });
  });

  it('tolerates missing sections', () => {
    expect(parseSnapshot({}, {}, {})).toMatchObject({ status: 'unknown', stage: 'unknown', appliedRev: 0, kvLastSeq: 0, consumerPending: 0 });
  });
});

type Step = { stage?: string; applied: number; last: number; pending?: number; ack?: number };

describe('createServerProbe', () => {
  const probeWith = (sequence: Step[]): ReturnType<typeof createServerProbe> => {
    let i = 0;
    const fakeFetch = vi.fn((url: string): Promise<Response> => {
      const step = sequence[Math.min(Math.floor(i / 3), sequence.length - 1)] ?? { applied: 0, last: 0 };
      i += 1;
      const body = url.endsWith('/health') ? health(step.stage) : url.includes('/debug/lag') ? lag(step.applied) : jsz(step.last, step.pending ?? 0, step.ack ?? 0);
      return Promise.resolve(new Response(JSON.stringify(body)));
    });
    return createServerProbe({ fetch: fakeFetch as unknown as typeof fetch });
  };

  it('is idle only on the second consecutive quiet snapshot', async () => {
    const probe = probeWith([{ applied: 42, last: 42 }, { applied: 42, last: 42 }]);
    expect(await probe.isIdle()).toBe(false);
    expect(await probe.isIdle()).toBe(true);
  });

  it('is not idle while the applied revision still moves between snapshots', async () => {
    const probe = probeWith([{ applied: 40, last: 42 }, { applied: 42, last: 42 }]);
    await probe.isIdle();
    expect(await probe.isIdle()).toBe(false);
  });

  it('is not idle while the blotter is behind the newest published change', async () => {
    const probe = probeWith([{ applied: 40, last: 42 }, { applied: 40, last: 42 }]);
    await probe.isIdle();
    expect(await probe.isIdle()).toBe(false);
  });

  it('is not idle while the order service has input pending or unacknowledged', async () => {
    const pending = probeWith([{ applied: 42, last: 42, pending: 2 }, { applied: 42, last: 42, pending: 2 }]);
    await pending.isIdle();
    expect(await pending.isIdle()).toBe(false);
    const unacked = probeWith([{ applied: 42, last: 42, ack: 3 }, { applied: 42, last: 42, ack: 3 }]);
    await unacked.isIdle();
    expect(await unacked.isIdle()).toBe(false);
  });

  it('is not idle until the blotter is ready', async () => {
    const probe = probeWith([{ stage: 'prices', applied: 42, last: 42 }, { stage: 'prices', applied: 42, last: 42 }]);
    await probe.isIdle();
    expect(await probe.isIdle()).toBe(false);
  });
});

describe('readCounter', () => {
  const text = [
    '# HELP apeiron_backpressure_events_total x',
    '# TYPE apeiron_backpressure_events_total counter',
    'apeiron_backpressure_events_total{event="soft_conflate"} 12',
    'apeiron_backpressure_events_total{event="slow_consumer"} 3',
    'apeiron_backpressure_events_total_other 99',
  ].join('\n');

  it('reads a labelled counter and ignores similarly named ones', () => {
    expect(readCounter(text, 'apeiron_backpressure_events_total', { event: 'slow_consumer' })).toBe(3);
    expect(readCounter(text, 'apeiron_backpressure_events_total', { event: 'soft_conflate' })).toBe(12);
    expect(readCounter(text, 'apeiron_backpressure_events_total')).toBe(15);
    expect(readCounter(text, 'missing')).toBe(0);
  });
});
