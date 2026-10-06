import { createConnectionCore, DEFAULT_CORE_OPTIONS, type Clock, type SocketLike } from './connection-core';
import type { MainToWorker, WorkerToMain } from './messages';

/** The slice of `DedicatedWorkerGlobalScope` the host needs. */
export type WorkerScope = {
  postMessage(message: WorkerToMain): void;
  onmessage: ((event: { data: MainToWorker }) => void) | null;
};

export type HostDeps = {
  createSocket: (url: string) => SocketLike;
  clock: Clock;
  clientId: string;
};

/** Wires the pure connection core to a worker scope: main-thread commands in, events out. */
export function attachWorkerHost(scope: WorkerScope, deps: HostDeps): void {
  const core = createConnectionCore({
    createSocket: deps.createSocket,
    clock: deps.clock,
    clientId: deps.clientId,
    options: DEFAULT_CORE_OPTIONS,
    emit: (event) => {
      scope.postMessage(event);
    },
  });

  scope.onmessage = (event): void => {
    const cmd = event.data;
    switch (cmd.kind) {
      case 'connect':
        core.connect(cmd.url);
        return;
      case 'hello':
        core.hello(cmd.id, cmd.traderId, cmd.codec);
        return;
      case 'request':
        core.request(cmd.msg);
        return;
      case 'close':
        core.close();
        return;
    }
  };
}
