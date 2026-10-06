import { EventEmitter } from 'node:events';
import type { RawData, WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import type { Connection, ConnectionHandlers } from './transport.js';
import { attachWebSocket, toFrame } from './ws-transport.js';

describe('toFrame', () => {
  it('decodes text frames to strings', () => {
    expect(toFrame(Buffer.from('héllo'), false)).toBe('héllo');
    expect(toFrame([Buffer.from('he'), Buffer.from('llo')], false)).toBe('hello');
  });

  it('passes binary frames through as bytes', () => {
    const buf = Buffer.from([1, 2, 3]);
    expect(toFrame(buf, true)).toBe(buf);
    expect([...(toFrame(new Uint8Array([4, 5]).buffer as RawData, true) as Uint8Array)]).toEqual([4, 5]);
    expect([...(toFrame([Buffer.from([1]), Buffer.from([2])], true) as Uint8Array)]).toEqual([1, 2]);
  });
});

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 7;
  send = vi.fn();
  close = vi.fn();
}

describe('attachWebSocket', () => {
  function attach(): { socket: FakeSocket; handlers: ConnectionHandlers; onError: ReturnType<typeof vi.fn>; conn: () => Connection } {
    const socket = new FakeSocket();
    const onFrame = vi.fn();
    const onClose = vi.fn();
    const handlers: ConnectionHandlers = { onFrame, onClose };
    const onError = vi.fn();
    let captured: Connection | undefined;
    attachWebSocket(
      socket as unknown as WebSocket,
      (c) => {
        captured = c;
        return handlers;
      },
      onError,
    );
    return { socket, handlers, onError, conn: () => captured as Connection };
  }

  it('forwards messages, close and errors to the handlers', () => {
    const { socket, handlers, onError } = attach();
    socket.emit('message', Buffer.from('{"t":"ping"}'), false);
    expect(handlers.onFrame).toHaveBeenCalledWith('{"t":"ping"}');
    socket.emit('message', Buffer.from([9]), true);
    expect(vi.mocked(handlers.onFrame).mock.calls[1]?.[0]).toBeInstanceOf(Uint8Array);
    socket.emit('close');
    expect(handlers.onClose).toHaveBeenCalled();
    const err = new Error('x');
    socket.emit('error', err);
    expect(onError).toHaveBeenCalledWith(err);
  });

  it('sends text for strings and binary for bytes, and ignores sends on a closed socket', () => {
    const { socket, conn } = attach();
    conn().send('hi');
    conn().send(new Uint8Array([1]));
    expect(socket.send).toHaveBeenNthCalledWith(1, 'hi', { binary: false });
    expect(socket.send).toHaveBeenNthCalledWith(2, new Uint8Array([1]), { binary: true });
    socket.readyState = 3;
    conn().send('late');
    expect(socket.send).toHaveBeenCalledTimes(2);
  });

  it('exposes bufferedAmount and close', () => {
    const { socket, conn } = attach();
    expect(conn().bufferedAmount).toBe(7);
    conn().close(1000, 'bye');
    expect(socket.close).toHaveBeenCalledWith(1000, 'bye');
  });
});
