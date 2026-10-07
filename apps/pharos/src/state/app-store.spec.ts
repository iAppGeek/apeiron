import { beforeEach, describe, expect, it } from 'vitest';
import { INITIAL_APP_STATE, resetAppStore, useAppStore } from './app-store';

const state = (): ReturnType<typeof useAppStore.getState> => useAppStore.getState();

describe('app store', () => {
  beforeEach(() => {
    resetAppStore();
  });

  it('starts connecting with all traders and the json codec', () => {
    expect(state()).toMatchObject({ status: 'connecting', requestedTrader: 'ALL', confirmedTrader: 'ALL', codec: 'json', welcomed: false, rowCount: null });
  });

  it('records connection state, welcome, codec, trader and counts', () => {
    state().setStatus('reconnecting', 3);
    state().setWelcomed([{ traderId: 'T1', traderName: 'Alice' }]);
    state().setCodec('msgpack');
    state().setRequestedTrader('T1');
    state().setConfirmedTrader('T1');
    state().setRowCount(1234, true);
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
      requestedTrader: 'T1',
      confirmedTrader: 'T1',
      rowCount: 1234,
      grouped: true,
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

  it('records the summary, live figures and load preset', () => {
    const summary = {
      byStatus: { PENDING_START: 1, LIVE: 2, PAUSED: 3, FILLED: 4, CANCELLED: 5 },
      liveNotionalUsd: 9,
      totalRows: 15,
    };
    state().setSummary(summary);
    state().setLive({ latencyP50Ms: 5, latencyP95Ms: 20, deltasPerSec: 9.9, rowsUpdatedPerSec: 450 });
    state().setPreset('stress');
    state().setPresetPending(true);
    expect(state()).toMatchObject({
      summary,
      latencyP50Ms: 5,
      latencyP95Ms: 20,
      deltasPerSec: 9.9,
      rowsUpdatedPerSec: 450,
      preset: 'stress',
      presetPending: true,
    });
  });

  it('counts new orders for the badge and clears them', () => {
    state().addNewOrders(3);
    state().addNewOrders(2);
    expect(state().newOrders).toBe(5);
    state().clearNewOrders();
    expect(state().newOrders).toBe(0);
  });

  it('does not touch the state when clearing an empty badge', () => {
    const before = state();
    state().clearNewOrders();
    expect(state()).toBe(before);
  });

  it('keeps a history of every toast, capped at 50', () => {
    const store = useAppStore.getState();
    for (let n = 0; n < 55; n += 1) store.pushToast(n % 2 === 0 ? 'error' : 'info', `t${n}`);
    const history = useAppStore.getState().toastHistory;
    expect(history).toHaveLength(50);
    expect(history[0]).toBe('info: t5');
    expect(history.at(-1)).toBe('error: t54');
    expect(useAppStore.getState().toasts.length).toBeLessThanOrEqual(4);
  });
});
