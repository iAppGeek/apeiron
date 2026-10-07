import type { ClientMsg } from '@apeiron/logos';
import { mulberry32 } from '@apeiron/logos';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TalosClient } from './client.js';
import { runNormalClient } from './normal-client.js';
import { RunRecorder } from './recorder.js';
import { realClock } from './schedule.js';
import { planClients } from './scenario.js';
import { FakeSocket, autoServer, type AutoServerOptions } from './testing/fake-socket.js';

afterEach(() => vi.useRealTimers());

async function run(seconds: number, server: AutoServerOptions = {}, over: Partial<Parameters<typeof runNormalClient>[0]> = {}): Promise<{ recorder: RunRecorder; seen: ClientMsg[]; client: TalosClient }> {
  vi.useFakeTimers({ now: 1_000_000 });
  const seen: ClientMsg[] = [];
  const socket = new FakeSocket();
  autoServer(socket, { ...server, seen: (m) => seen.push(m) });
  const recorder = new RunRecorder(Date.now());
  const plan = planClients({ clients: 1, codec: 'json', seed: 4, special: false, nowMs: Date.now() })[0] as ReturnType<typeof planClients>[number];
  const client = new TalosClient({ clientId: plan.clientId, traderId: plan.traderId, codec: 'json', socket, clock: realClock, recorder });
  const done = runNormalClient({
    client,
    plan,
    clock: realClock,
    recorder,
    rng: mulberry32(9),
    nowMs: Date.now(),
    endMs: Date.now() + seconds * 1000,
    scrollPerSec: 2,
    changeEverySec: 10,
    commandPerSec: 0.5,
    stopped: () => false,
    ...over,
  });
  await vi.advanceTimersByTimeAsync(seconds * 1000 + 1000);
  await done;
  return { recorder, seen, client };
}

describe('runNormalClient', () => {
  it('says hello, opens its view, then scrolls about twice a second in 100-row blocks', async () => {
    const { recorder, seen } = await run(30);
    expect(seen[0]).toMatchObject({ t: 'hello' });
    const getRows = seen.filter((m): m is Extract<ClientMsg, { t: 'getRows' }> => m.t === 'getRows');
    expect(recorder.counters.scrolls).toBeGreaterThanOrEqual(55);
    expect(recorder.counters.scrolls).toBeLessThanOrEqual(62);
    expect(getRows.length).toBeGreaterThan(55);
    for (const m of getRows) expect(m.req.endRow - m.req.startRow).toBe(100);
    expect(recorder.forCodec('json').rowsWarm.count).toBeGreaterThan(50);
  });

  it('changes the view now and then and files the first request of each new view as cold', async () => {
    const { recorder, seen } = await run(60);
    expect(recorder.counters.viewChanges).toBeGreaterThanOrEqual(4);
    const views = new Set(seen.filter((m) => m.t === 'getRows').map((m) => JSON.stringify([m.t === 'getRows' ? m.req.sortModel : 0, m.t === 'getRows' ? m.req.filterModel : 0, m.t === 'getRows' ? m.req.rowGroupCols : 0])));
    expect(views.size).toBeGreaterThan(2);
    expect(recorder.forCodec('json').rowsCold.count).toBe(1 + recorder.counters.viewChanges);
  });

  it('records the send lag of every scheduled request', async () => {
    const { recorder } = await run(10);
    expect(recorder.sendLags.count).toBeGreaterThan(20);
    expect(Math.max(...recorder.sendLags.values())).toBeLessThan(5);
  });

  it('pauses a LIVE order it has seen, then resumes it, and measures the ack', async () => {
    const rows = [{ orderId: 'LIVE1', status: 'LIVE' }];
    const { recorder, seen } = await run(60, { rows });
    const commands = seen.filter((m): m is Extract<ClientMsg, { t: 'command' }> => m.t === 'command');
    expect(commands.length).toBeGreaterThanOrEqual(10);
    expect(commands.every((c) => c.orderId === 'LIVE1')).toBe(true);
    expect(commands[0]?.action).toBe('PAUSE');
    expect(recorder.forCodec('json').commandAck.count).toBe(commands.length);
  });

  it('skips commands when it has seen no LIVE order', async () => {
    const { recorder, seen } = await run(30, { rows: [{ orderId: 'F1', status: 'FILLED' }] });
    expect(seen.some((m) => m.t === 'command')).toBe(false);
    expect(recorder.counters.commandsSkipped).toBeGreaterThan(5);
  });

  it('keeps going after a command is rejected', async () => {
    const { recorder } = await run(40, { rows: [{ orderId: 'LIVE1', status: 'LIVE' }], commandError: 'INVALID_TRANSITION' });
    expect(Object.fromEntries(recorder.commandRejects).INVALID_TRANSITION).toBeGreaterThan(2);
  });

  it('pings so the clock offset stays fresh', async () => {
    const { seen } = await run(30);
    expect(seen.filter((m) => m.t === 'ping').length).toBeGreaterThanOrEqual(5);
  });

  it('gives up cleanly when the server never welcomes it', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const socket = new FakeSocket();
    const recorder = new RunRecorder(Date.now());
    const plan = planClients({ clients: 1, codec: 'json', seed: 1, special: false, nowMs: Date.now() })[0] as ReturnType<typeof planClients>[number];
    const client = new TalosClient({ clientId: 'c', traderId: 'ALL', codec: 'json', socket, clock: realClock, recorder });
    const done = runNormalClient({ client, plan, clock: realClock, recorder, rng: mulberry32(1), nowMs: Date.now(), endMs: Date.now() + 5000, scrollPerSec: 2, changeEverySec: 10, commandPerSec: 0.1, stopped: () => false });
    await vi.advanceTimersByTimeAsync(11_000);
    await done;
    expect(recorder.counters.connectFailures).toBe(1);
    expect(recorder.counters.scrolls).toBe(0);
  });

  it('counts an unexpected close', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const socket = new FakeSocket();
    autoServer(socket);
    const recorder = new RunRecorder(Date.now());
    const plan = planClients({ clients: 1, codec: 'json', seed: 1, special: false, nowMs: Date.now() })[0] as ReturnType<typeof planClients>[number];
    const client = new TalosClient({ clientId: 'c', traderId: 'ALL', codec: 'json', socket, clock: realClock, recorder });
    const done = runNormalClient({ client, plan, clock: realClock, recorder, rng: mulberry32(1), nowMs: Date.now(), endMs: Date.now() + 10_000, scrollPerSec: 2, changeEverySec: 10, commandPerSec: 0.1, stopped: () => false });
    await vi.advanceTimersByTimeAsync(3000);
    socket.serverClose(1006);
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(recorder.counters.unexpectedCloses).toBe(1);
  });
});
