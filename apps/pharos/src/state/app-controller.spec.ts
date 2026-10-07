import type { ServerMsg } from '@apeiron/logos';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestError, type BlotterClient, type ClientEvents } from '../transport/client';
import type { WelcomeMsg } from '../transport/messages';
import { createAppController } from './app-controller';
import { resetAppStore, useAppStore } from './app-store';

type Handlers = { [E in keyof ClientEvents]?: (payload: ClientEvents[E]) => void };
type FakeClient = BlotterClient & {
  handlers: Handlers;
  hello: ReturnType<typeof vi.fn>;
  control: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
};

const welcome: WelcomeMsg = { t: 'welcome', serverTime: 1, traders: [{ traderId: 'T1', traderName: 'Alice' }], columnsVersion: 'v', preset: null };

const makeClient = (): FakeClient => {
  const handlers: Handlers = {};
  const off = vi.fn();
  const client = {
    handlers,
    off,
    connect: vi.fn(),
    hello: vi.fn().mockResolvedValue(welcome),
    getRows: vi.fn(),
    setFilterValues: vi.fn(),
    control: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    on: (event: keyof ClientEvents, handler: never): (() => void) => {
      (handlers as Record<string, unknown>)[event] = handler;
      return off;
    },
  };
  return client as unknown as FakeClient;
};

const emitMessage = (c: FakeClient, msg: ServerMsg): void => {
  c.handlers.message?.(msg);
};

describe('createAppController', () => {
  beforeEach(() => {
    resetAppStore();
  });

  it('connects and says hello, wiring status, stats and welcome into the store', async () => {
    const client = makeClient();
    const controller = createAppController(client);
    controller.start('ws://x/ws');
    expect(client.connect).toHaveBeenCalledWith('ws://x/ws');
    expect(client.hello).toHaveBeenCalledWith('ALL', 'json');

    client.handlers.status?.({ status: 'connected', attempt: 0, codec: 'json' });
    client.handlers.stats?.({ msgsIn: 3, msgsOut: 2, deltasIn: 0, rttMs: 9, clockOffsetMs: null });
    emitMessage(client, welcome);
    expect(useAppStore.getState()).toMatchObject({
      status: 'connected',
      msgsInPerSec: 3,
      rttMs: 9,
      welcomed: true,
      traders: welcome.traders,
    });
  });

  it('start returns an unsubscribe function', () => {
    const client = makeClient();
    const stop = createAppController(client).start('ws://x/ws');
    stop();
    expect(client.off).toHaveBeenCalledTimes(4);
  });

  it('does not toast when the initial hello is cut by a dropped link, but does for real errors', async () => {
    const client = makeClient();
    client.hello.mockRejectedValueOnce(new RequestError({ code: 'DISCONNECTED', message: 'gone' }));
    createAppController(client).start('ws://x/ws');
    await Promise.resolve();
    await Promise.resolve();
    expect(useAppStore.getState().toasts).toHaveLength(0);

    const client2 = makeClient();
    client2.hello.mockRejectedValueOnce(new RequestError({ code: 'UNKNOWN_TRADER', message: 'no' }));
    createAppController(client2).start('ws://x/ws');
    await vi.waitFor(() => {
      expect(useAppStore.getState().toasts).toHaveLength(1);
    });
  });

  it('changes trader: hello, store update, then purge', async () => {
    const client = makeClient();
    const controller = createAppController(client);
    const purge = vi.fn();
    controller.setPurge(purge);
    useAppStore.getState().setRowCount(1000);
    await controller.changeTrader('T1');
    expect(client.hello).toHaveBeenCalledWith('T1', 'json');
    expect(useAppStore.getState().requestedTrader).toBe('T1');
    expect(useAppStore.getState().confirmedTrader).toBe('T1');
    expect(useAppStore.getState().rowCount).toBeNull();
    expect(purge).toHaveBeenCalledTimes(1);
  });

  it('keeps the trader and does not purge when the server rejects the hello', async () => {
    const client = makeClient();
    client.hello.mockRejectedValue(new RequestError({ code: 'UNKNOWN_TRADER', message: 'Unknown trader: Z' }));
    const controller = createAppController(client);
    const purge = vi.fn();
    controller.setPurge(purge);
    await controller.changeTrader('Z');
    expect(useAppStore.getState().requestedTrader).toBe('ALL');
    expect(useAppStore.getState().confirmedTrader).toBe('ALL');
    expect(purge).not.toHaveBeenCalled();
    expect(useAppStore.getState().toasts[0]?.text).toMatch(/trader/i);
  });

  it('changes codec by re-sending hello with the current trader, then purges because the server dropped what it tracked', async () => {
    const client = makeClient();
    const controller = createAppController(client);
    const purge = vi.fn();
    controller.setPurge(purge);
    useAppStore.getState().setRequestedTrader('T1');
    await controller.changeCodec('msgpack');
    expect(client.hello).toHaveBeenCalledWith('T1', 'msgpack');
    expect(useAppStore.getState().codec).toBe('msgpack');
    expect(purge).toHaveBeenCalledTimes(1);
  });

  it('leaves the codec alone and toasts when the hello fails', async () => {
    const client = makeClient();
    client.hello.mockRejectedValue(new Error('boom'));
    await createAppController(client).changeCodec('msgpack');
    expect(useAppStore.getState().codec).toBe('json');
    expect(useAppStore.getState().toasts[0]?.text).toBe('boom');
  });

  it('keeps the old trader confirmed (and shows switching) until the server confirms the new one', async () => {
    const client = makeClient();
    let confirm: (w: WelcomeMsg) => void = () => undefined;
    client.hello.mockImplementation(
      () =>
        new Promise<WelcomeMsg>((resolve) => {
          confirm = resolve;
        }),
    );
    const controller = createAppController(client);
    const purge = vi.fn();
    controller.setPurge(purge);
    const pending = controller.changeTrader('T2');
    expect(useAppStore.getState().requestedTrader).toBe('T2');
    expect(useAppStore.getState().confirmedTrader).toBe('ALL');
    expect(purge).not.toHaveBeenCalled();
    confirm(welcome);
    await pending;
    expect(useAppStore.getState().confirmedTrader).toBe('T2');
    expect(purge).toHaveBeenCalledTimes(1);
  });

  it('keeps the request when the link drops mid-switch and confirms it on the reconnect welcome', async () => {
    const client = makeClient();
    client.hello
      .mockResolvedValueOnce(welcome)
      .mockRejectedValueOnce(new RequestError({ code: 'DISCONNECTED', message: 'gone' }));
    const controller = createAppController(client);
    const purge = vi.fn();
    controller.setPurge(purge);
    controller.start('ws://x/ws');
    await controller.changeTrader('T2');
    expect(useAppStore.getState().requestedTrader).toBe('T2');
    expect(useAppStore.getState().confirmedTrader).toBe('ALL');
    expect(useAppStore.getState().toasts).toHaveLength(0);
    emitMessage(client, welcome);
    expect(useAppStore.getState().confirmedTrader).toBe('T2');
    expect(purge).toHaveBeenCalledTimes(1);
  });

  it('sends the requested trader in the first hello and when the codec changes', async () => {
    const client = makeClient();
    useAppStore.getState().setRequestedTrader('T4');
    createAppController(client).start('ws://x/ws');
    expect(client.hello).toHaveBeenCalledWith('T4', 'json');
  });

  it('stores server stats from summary, toasts stray errors and hands deltas to the delta handler', () => {
    const client = makeClient();
    const controller = createAppController(client);
    controller.start('ws://x/ws');
    emitMessage(client, {
      t: 'summary',
      byStatus: { PENDING_START: 0, LIVE: 0, PAUSED: 0, FILLED: 0, CANCELLED: 0 },
      liveNotionalUsd: 0,
      totalRows: 0,
      server: { cpu: 7, rssMb: 700, elLagMs: 2 },
      preset: null,
    });
    expect(useAppStore.getState().server).toEqual({ cpu: 7, rssMb: 700, elLagMs: 2 });

    emitMessage(client, { t: 'error', code: 'INTERNAL', message: 'bad' });
    expect(useAppStore.getState().toasts).toHaveLength(1);

    const handler = vi.fn();
    controller.setDeltaHandler(handler);
    const delta: ServerMsg = { t: 'delta', seq: 1, serverTs: 1, srcTs: 1, updates: [], groupUpdates: [], adds: [], dirtyRoutes: [], rowCounts: [], newAbove: 0 };
    emitMessage(client, delta);
    expect(handler).toHaveBeenCalledWith(delta);
    emitMessage(client, { t: 'ack', reqId: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  describe('summary', () => {
    it('stores the status counts, live notional and total rows alongside the server stats', () => {
      const client = makeClient();
      createAppController(client).start('ws://x/ws');
      emitMessage(client, {
        t: 'summary',
        byStatus: { PENDING_START: 1, LIVE: 2, PAUSED: 3, FILLED: 4, CANCELLED: 5 },
        liveNotionalUsd: 4.2e9,
        totalRows: 1_000_015,
        server: { cpu: 7, rssMb: 700, elLagMs: 2 },
        preset: null,
      });
      expect(useAppStore.getState().summary).toEqual({
        byStatus: { PENDING_START: 1, LIVE: 2, PAUSED: 3, FILLED: 4, CANCELLED: 5 },
        liveNotionalUsd: 4.2e9,
        totalRows: 1_000_015,
      });
    });
  });

  describe('live metrics', () => {
    /** `srcTs` is when the source event happened; the delta was stamped (and sent) 1 ms later. */
    const delta = (srcTs: number): ServerMsg => ({
      t: 'delta',
      seq: 1,
      serverTs: srcTs + 1,
      srcTs,
      updates: [],
      groupUpdates: [],
      adds: [],
      dirtyRoutes: [],
      rowCounts: [],
      newAbove: 0,
    });

    it('measures tick-to-screen latency per applied delta and publishes p50 and p95 with each stats event', () => {
      const client = makeClient();
      const clock = { t: 10_000 };
      const controller = createAppController(client, { now: () => clock.t });
      controller.start('ws://x/ws');
      controller.setDeltaHandler(() => ({ rowsUpdated: 0, rowsAdded: 0, skipped: 0, rootRowCount: null }));
      for (const latency of [10, 20, 30, 40, 100]) {
        clock.t += 100;
        emitMessage(client, delta(clock.t - latency));
      }
      clock.t += 100;
      client.handlers.stats?.({ msgsIn: 5, msgsOut: 1, deltasIn: 5, rttMs: 1, clockOffsetMs: 0 });
      expect(useAppStore.getState()).toMatchObject({ latencyP50Ms: 30, latencyP95Ms: 100, deltasPerSec: 5 });
    });

    it('measures from the source event (srcTs), not from when the server stamped the delta', () => {
      const client = makeClient();
      const clock = { t: 10_000 };
      const controller = createAppController(client, { now: () => clock.t });
      controller.start('ws://x/ws');
      controller.setDeltaHandler(() => undefined);
      // Sourced 90 ms ago, but the flush only stamped it 10 ms ago: the trader waited 90 ms.
      emitMessage(client, { ...(delta(clock.t - 90) as Extract<ServerMsg, { t: 'delta' }>), serverTs: clock.t - 10 });
      client.handlers.stats?.({ msgsIn: 0, msgsOut: 0, deltasIn: 1, rttMs: 1, clockOffsetMs: 0 });
      expect(useAppStore.getState().latencyP50Ms).toBe(90);
    });

    it('corrects the latency for the clock offset the transport estimated', () => {
      const client = makeClient();
      const clock = { t: 10_000 };
      const controller = createAppController(client, { now: () => clock.t });
      controller.start('ws://x/ws');
      controller.setDeltaHandler(() => undefined);
      // The server clock runs 5s ahead; the tick was stamped 25ms before it was applied.
      client.handlers.stats?.({ msgsIn: 0, msgsOut: 0, deltasIn: 0, rttMs: 1, clockOffsetMs: 5000 });
      emitMessage(client, delta(10_000 + 5000 - 25));
      client.handlers.stats?.({ msgsIn: 0, msgsOut: 0, deltasIn: 1, rttMs: 1, clockOffsetMs: 5000 });
      expect(useAppStore.getState().latencyP50Ms).toBe(25);
    });

    it('only measures deltas that a handler applied, and shows no latency before then', () => {
      const client = makeClient();
      const controller = createAppController(client, { now: () => 5 });
      controller.start('ws://x/ws');
      emitMessage(client, delta(1));
      client.handlers.stats?.({ msgsIn: 0, msgsOut: 0, deltasIn: 1, rttMs: 1, clockOffsetMs: null });
      expect(useAppStore.getState().latencyP50Ms).toBeNull();
    });

    it('drops latency samples older than ten seconds', () => {
      const client = makeClient();
      const clock = { t: 0 };
      const controller = createAppController(client, { now: () => clock.t });
      controller.start('ws://x/ws');
      controller.setDeltaHandler(() => undefined);
      emitMessage(client, delta(-500));
      clock.t = 10_001;
      client.handlers.stats?.({ msgsIn: 0, msgsOut: 0, deltasIn: 0, rttMs: 1, clockOffsetMs: 0 });
      expect(useAppStore.getState().latencyP95Ms).toBeNull();
    });

    it('publishes rows updated per second and follows the root row count', () => {
      const client = makeClient();
      const clock = { t: 0 };
      const controller = createAppController(client, { now: () => clock.t });
      controller.start('ws://x/ws');
      useAppStore.getState().setRowCount(20, true);
      controller.setDeltaHandler(() => ({ rowsUpdated: 300, rowsAdded: 0, skipped: 0, rootRowCount: 21 }));
      emitMessage(client, delta(0));
      emitMessage(client, delta(0));
      clock.t = 2000;
      client.handlers.stats?.({ msgsIn: 0, msgsOut: 0, deltasIn: 0, rttMs: 1, clockOffsetMs: 0 });
      expect(useAppStore.getState().rowsUpdatedPerSec).toBe(300);
      expect(useAppStore.getState()).toMatchObject({ rowCount: 21, grouped: true });
    });
  });

  describe('slow consumer and reconnects', () => {
    const started = (): { client: FakeClient; purge: ReturnType<typeof vi.fn> } => {
      const client = makeClient();
      const controller = createAppController(client);
      const purge = vi.fn();
      controller.setPurge(purge);
      controller.start('ws://x/ws');
      emitMessage(client, welcome);
      return { client, purge };
    };

    it('toasts on SLOW_CONSUMER, and purges when the reconnect is welcomed', () => {
      const { client, purge } = started();
      emitMessage(client, { t: 'error', code: 'SLOW_CONSUMER', message: 'behind' });
      expect(useAppStore.getState().toasts).toHaveLength(1);
      expect(useAppStore.getState().toasts[0]?.text).toMatch(/fell behind/i);
      expect(purge).not.toHaveBeenCalled();
      emitMessage(client, welcome);
      expect(purge).toHaveBeenCalledTimes(1);
      emitMessage(client, welcome);
      expect(purge).toHaveBeenCalledTimes(1);
    });

    it('treats close code 1013 the same way', () => {
      const { client, purge } = started();
      client.handlers.closed?.({ code: 1013 });
      expect(useAppStore.getState().toasts).toHaveLength(1);
      emitMessage(client, welcome);
      expect(purge).toHaveBeenCalledTimes(1);
    });

    it('shows one toast when both the error and the close code arrive', () => {
      const { client } = started();
      emitMessage(client, { t: 'error', code: 'SLOW_CONSUMER', message: 'behind' });
      client.handlers.closed?.({ code: 1013 });
      expect(useAppStore.getState().toasts).toHaveLength(1);
    });

    it('toasts again for a later slow-consumer episode', () => {
      const { client } = started();
      client.handlers.closed?.({ code: 1013 });
      emitMessage(client, welcome);
      client.handlers.closed?.({ code: 1013 });
      expect(useAppStore.getState().toasts).toHaveLength(2);
    });

    it('purges after any unexpected close, with no toast, because a fresh session tracks nothing', () => {
      const { client, purge } = started();
      client.handlers.closed?.({ code: 1006 });
      client.handlers.closed?.({ code: null });
      expect(useAppStore.getState().toasts).toHaveLength(0);
      emitMessage(client, welcome);
      expect(purge).toHaveBeenCalledTimes(1);
    });

    it('does not purge a grid that was never loaded when the first connection attempts fail', () => {
      const client = makeClient();
      const controller = createAppController(client);
      const purge = vi.fn();
      controller.setPurge(purge);
      controller.start('ws://x/ws');
      client.handlers.closed?.({ code: 1006 });
      emitMessage(client, welcome);
      expect(purge).not.toHaveBeenCalled();
    });

    it('purges once when a reconnect also confirms a pending trader change', () => {
      const client = makeClient();
      client.hello
        .mockResolvedValueOnce(welcome)
        .mockRejectedValueOnce(new RequestError({ code: 'DISCONNECTED', message: 'gone' }));
      const controller = createAppController(client);
      const purge = vi.fn();
      controller.setPurge(purge);
      controller.start('ws://x/ws');
      emitMessage(client, welcome);
      return controller.changeTrader('T2').then(() => {
        client.handlers.closed?.({ code: 1006 });
        emitMessage(client, welcome);
        expect(purge).toHaveBeenCalledTimes(1);
        expect(useAppStore.getState().confirmedTrader).toBe('T2');
      });
    });
  });

  describe('load preset', () => {
    it('sends the preset and records it once the server has acknowledged', async () => {
      const client = makeClient();
      let ack: () => void = () => undefined;
      client.control.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            ack = resolve;
          }),
      );
      const pending = createAppController(client).changePreset('stress');
      expect(client.control).toHaveBeenCalledWith('stress');
      expect(useAppStore.getState()).toMatchObject({ preset: null, presetPending: true });
      ack();
      await pending;
      expect(useAppStore.getState()).toMatchObject({ preset: 'stress', presetPending: false });
    });

    it('keeps the old preset and toasts when the server refuses', async () => {
      const client = makeClient();
      useAppStore.getState().setPreset('medium');
      client.control.mockRejectedValue(new RequestError({ code: 'NOT_IMPLEMENTED', message: 'no bus' }));
      await createAppController(client).changePreset('stress');
      expect(useAppStore.getState()).toMatchObject({ preset: 'medium', presetPending: false });
      expect(useAppStore.getState().toasts).toHaveLength(1);
    });
  });

  describe('reported load preset', () => {
    const summary = (preset: 'medium' | 'stress' | null): ServerMsg => ({
      t: 'summary',
      byStatus: { PENDING_START: 0, LIVE: 0, PAUSED: 0, FILLED: 0, CANCELLED: 0 },
      liveNotionalUsd: 0,
      totalRows: 0,
      server: { cpu: 1, rssMb: 1, elLagMs: 1 },
      preset,
    });

    it('takes the preset from welcome straight away', () => {
      const client = makeClient();
      createAppController(client).start('ws://x/ws');
      emitMessage(client, { ...welcome, preset: 'stress' });
      expect(useAppStore.getState().preset).toBe('stress');
    });

    it('follows the preset in each summary, so a change made elsewhere shows up', () => {
      const client = makeClient();
      createAppController(client).start('ws://x/ws');
      emitMessage(client, summary('stress'));
      expect(useAppStore.getState().preset).toBe('stress');
      emitMessage(client, summary('medium'));
      expect(useAppStore.getState().preset).toBe('medium');
    });

    it('does not let an unknown (null) preset hide a known one', () => {
      const client = makeClient();
      createAppController(client).start('ws://x/ws');
      emitMessage(client, summary('stress'));
      emitMessage(client, summary(null));
      emitMessage(client, welcome);
      expect(useAppStore.getState().preset).toBe('stress');
    });
  });

  it('switches the codec json to msgpack to json, re-sending hello each time and purging each time', async () => {
    const client = makeClient();
    const controller = createAppController(client);
    const purge = vi.fn();
    controller.setPurge(purge);
    await controller.changeCodec('msgpack');
    await controller.changeCodec('json');
    await controller.changeCodec('msgpack');
    expect(client.hello.mock.calls.map((c) => c[1])).toEqual(['msgpack', 'json', 'msgpack']);
    expect(useAppStore.getState().codec).toBe('msgpack');
    expect(purge).toHaveBeenCalledTimes(3);
  });
});
