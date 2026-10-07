import { describe, expect, it, vi } from 'vitest';
import { createServerProbe, parseSnapshot } from './server-probe';

const health = { status: 'ok', rows: 10, live: { clients: 2, pendingEvents: 0 } };
const lag = (events: number, ticks: number): unknown => ({ live: { eventsApplied: events, ticksApplied: ticks }, flush: { lastMs: 0.3 } });
const jsz = (pending: number, ack: number): unknown => ({
  account_details: [{ stream_detail: [{ consumer_detail: [{ name: 'hermes-commands', num_pending: 9, num_ack_pending: 9 }, { name: 'blotter-server', num_pending: pending, num_ack_pending: ack }] }] }],
});

describe('parseSnapshot', () => {
  it('reads the blotter-server consumer only', () => {
    expect(parseSnapshot(health, lag(5, 6), jsz(3, 4))).toMatchObject({
      status: 'ok',
      rows: 10,
      clients: 2,
      eventsApplied: 5,
      ticksApplied: 6,
      consumerPending: 3,
      consumerAckPending: 4,
    });
  });

  it('tolerates missing sections', () => {
    expect(parseSnapshot({}, {}, {})).toMatchObject({ status: 'unknown', consumerPending: 0, eventsApplied: 0 });
  });
});

describe('createServerProbe', () => {
  const probeWith = (sequence: { events: number; pending: number; ack: number }[]): ReturnType<typeof createServerProbe> => {
    let i = 0;
    const fakeFetch = vi.fn((url: string): Promise<Response> => {
      const step = sequence[Math.min(Math.floor(i / 3), sequence.length - 1)] ?? { events: 0, pending: 0, ack: 0 };
      i += 1;
      const body = url.endsWith('/health') ? health : url.includes('/debug/lag') ? lag(step.events, 0) : jsz(step.pending, step.ack);
      return Promise.resolve(new Response(JSON.stringify(body)));
    });
    return createServerProbe({ fetch: fakeFetch as unknown as typeof fetch });
  };

  it('is idle only on the second consecutive quiet snapshot', async () => {
    const probe = probeWith([{ events: 5, pending: 0, ack: 0 }, { events: 5, pending: 0, ack: 0 }]);
    expect(await probe.isIdle()).toBe(false);
    expect(await probe.isIdle()).toBe(true);
  });

  it('is not idle while events are still being applied or acks are outstanding', async () => {
    const applying = probeWith([{ events: 5, pending: 0, ack: 0 }, { events: 9, pending: 0, ack: 0 }]);
    await applying.isIdle();
    expect(await applying.isIdle()).toBe(false);
    const unacked = probeWith([{ events: 5, pending: 0, ack: 3 }, { events: 5, pending: 0, ack: 3 }]);
    await unacked.isIdle();
    expect(await unacked.isIdle()).toBe(false);
  });
});
