import { beforeEach, describe, expect, it } from 'vitest';
import { INITIAL_APP_STATE, resetAppStore, useAppStore } from './app-store';

const state = (): ReturnType<typeof useAppStore.getState> => useAppStore.getState();

describe('app store', () => {
  beforeEach(() => {
    resetAppStore();
  });

  it('starts connecting with all traders and the json codec', () => {
    expect(state()).toMatchObject({ status: 'connecting', traderId: 'ALL', codec: 'json', welcomed: false, rowCount: null });
  });

  it('records connection state, welcome, codec, trader and counts', () => {
    state().setStatus('reconnecting', 3);
    state().setWelcomed([{ traderId: 'T1', traderName: 'Alice' }]);
    state().setCodec('msgpack');
    state().setTraderId('T1');
    state().setRowCount(1234);
    state().setStats({ msgsIn: 5, msgsOut: 6, rttMs: 4 });
    state().setFps(59);
    state().setServer({ cpu: 12, rssMb: 800, elLagMs: 1 });
    state().setNotReady(true);
    expect(state()).toMatchObject({
      status: 'reconnecting',
      reconnectAttempt: 3,
      welcomed: true,
      traders: [{ traderId: 'T1', traderName: 'Alice' }],
      codec: 'msgpack',
      traderId: 'T1',
      rowCount: 1234,
      msgsInPerSec: 5,
      msgsOutPerSec: 6,
      rttMs: 4,
      fps: 59,
      server: { cpu: 12, rssMb: 800, elLagMs: 1 },
      notReady: true,
    });
  });

  it('adds, dismisses and caps toasts', () => {
    const a = state().pushToast('error', 'one');
    state().pushToast('info', 'two');
    expect(state().toasts.map((t) => t.text)).toEqual(['one', 'two']);
    state().dismissToast(a);
    expect(state().toasts.map((t) => t.text)).toEqual(['two']);
    for (let i = 0; i < 10; i += 1) state().pushToast('error', `t${i}`);
    expect(state().toasts).toHaveLength(4);
    expect(state().toasts.at(-1)?.text).toBe('t9');
  });

  it('resets to the initial state', () => {
    state().setRowCount(5);
    resetAppStore();
    expect(state().rowCount).toBe(INITIAL_APP_STATE.rowCount);
  });
});
