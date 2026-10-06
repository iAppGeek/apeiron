import { describe, expect, it, vi } from 'vitest';
import type { Clock, SocketLike } from './connection-core';
import type { MainToWorker, WorkerToMain } from './messages';
import { attachWorkerHost, type WorkerScope } from './worker-host';

const clock: Clock = {
  now: () => 0,
  setTimeout: () => 1,
  clearTimeout: () => undefined,
  setInterval: () => 2,
  clearInterval: () => undefined,
  random: () => 0.5,
};

const makeSocket = (): SocketLike & { send: ReturnType<typeof vi.fn<(d: string | Uint8Array) => void>>; close: ReturnType<typeof vi.fn<() => void>> } => ({
  readyState: 1,
  binaryType: '',
  send: vi.fn<(d: string | Uint8Array) => void>(),
  close: vi.fn<() => void>(),
  onopen: null,
  onmessage: null,
  onclose: null,
  onerror: null,
});

const makeScope = (): { scope: WorkerScope; posted: WorkerToMain[]; send: (m: MainToWorker) => void } => {
  const posted: WorkerToMain[] = [];
  const scope: WorkerScope = { postMessage: (m) => posted.push(m), onmessage: null };
  return { scope, posted, send: (data) => scope.onmessage?.({ data }) };
};

describe('attachWorkerHost', () => {
  it('connects, says hello first, and relays requests to the socket', () => {
    const { scope, posted, send } = makeScope();
    const socket = makeSocket();
    const createSocket = vi.fn(() => socket);
    attachWorkerHost(scope, { createSocket, clock, clientId: 'c1' });

    send({ kind: 'connect', url: 'ws://h/ws' });
    expect(createSocket).toHaveBeenCalledWith('ws://h/ws');
    expect(posted[0]).toMatchObject({ kind: 'status', status: 'connecting' });

    socket.onopen?.();
    send({ kind: 'request', msg: { t: 'setFilterValues', reqId: 1, colId: 'venue' } });
    expect(socket.send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(socket.send.mock.calls[0]?.[0] as string)).toMatchObject({ t: 'hello', clientId: 'c1' });
  });

  it('forwards hello commands and closes on request', () => {
    const { scope, posted, send } = makeScope();
    const socket = makeSocket();
    attachWorkerHost(scope, { createSocket: () => socket, clock, clientId: 'c1' });
    send({ kind: 'connect', url: 'ws://h/ws' });
    send({ kind: 'hello', id: 1, traderId: 'T3', codec: 'json' });
    socket.onopen?.();
    expect(JSON.parse(socket.send.mock.calls[0]?.[0] as string)).toMatchObject({ traderId: 'T3' });
    send({ kind: 'close' });
    expect(socket.close).toHaveBeenCalled();
    expect(posted.at(-1)).toMatchObject({ kind: 'status', status: 'closed' });
  });
});
