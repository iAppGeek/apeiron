import type { SocketLike } from './connection-core';
import { attachWorkerHost, type WorkerScope } from './worker-host';

// Worker entry. Only this file touches `self`, `WebSocket` and the real timers.
const scope = self as unknown as WorkerScope;

attachWorkerHost(scope, {
  clientId: crypto.randomUUID(),
  // The browser WebSocket has the members SocketLike lists; its handler types are just wider.
  createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
  clock: {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => {
      clearTimeout(handle as number);
    },
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => {
      clearInterval(handle as number);
    },
    random: () => Math.random(),
    // Chrome workers have requestAnimationFrame; elsewhere the core falls back to a 16ms timeout.
    ...(typeof self.requestAnimationFrame === 'function'
      ? {
          nextFrame: (fn: () => void): unknown => self.requestAnimationFrame(() => {
            fn();
          }),
          cancelFrame: (handle: unknown): void => {
            self.cancelAnimationFrame(handle as number);
          },
        }
      : {}),
  },
});
