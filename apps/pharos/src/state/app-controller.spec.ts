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
  connect: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
};

const welcome: WelcomeMsg = { t: 'welcome', serverTime: 1, traders: [{ traderId: 'T1', traderName: 'Alice' }], columnsVersion: 'v' };

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
    client.handlers.stats?.({ msgsIn: 3, msgsOut: 2, rttMs: 9 });
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
    expect(client.off).toHaveBeenCalledTimes(3);
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
    expect(useAppStore.getState().traderId).toBe('T1');
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
    expect(useAppStore.getState().traderId).toBe('ALL');
    expect(purge).not.toHaveBeenCalled();
    expect(useAppStore.getState().toasts[0]?.text).toMatch(/trader/i);
  });

  it('changes codec by re-sending hello with the current trader, without purging', async () => {
    const client = makeClient();
    const controller = createAppController(client);
    const purge = vi.fn();
    controller.setPurge(purge);
    useAppStore.getState().setTraderId('T1');
    await controller.changeCodec('msgpack');
    expect(client.hello).toHaveBeenCalledWith('T1', 'msgpack');
    expect(useAppStore.getState().codec).toBe('msgpack');
    expect(purge).not.toHaveBeenCalled();
  });

  it('leaves the codec alone and toasts when the hello fails', async () => {
    const client = makeClient();
    client.hello.mockRejectedValue(new Error('boom'));
    await createAppController(client).changeCodec('msgpack');
    expect(useAppStore.getState().codec).toBe('json');
    expect(useAppStore.getState().toasts[0]?.text).toBe('boom');
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
    });
    expect(useAppStore.getState().server).toEqual({ cpu: 7, rssMb: 700, elLagMs: 2 });

    emitMessage(client, { t: 'error', code: 'INTERNAL', message: 'bad' });
    expect(useAppStore.getState().toasts).toHaveLength(1);

    const handler = vi.fn();
    controller.setDeltaHandler(handler);
    const delta: ServerMsg = { t: 'delta', seq: 1, serverTs: 1, updates: [], groupUpdates: [], adds: [], dirtyRoutes: [], rowCounts: [], newAbove: 0 };
    emitMessage(client, delta);
    expect(handler).toHaveBeenCalledWith(delta);
    emitMessage(client, { t: 'ack', reqId: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
