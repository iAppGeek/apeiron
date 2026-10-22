import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { accessHeaders, connectWebSocket, webSocketConnector } from './socket.js';

const servers: WebSocketServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    for (const c of s.clients) c.terminate();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

async function echoServer(): Promise<string> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  server.on('connection', (ws) => ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary })));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('connectWebSocket', () => {
  it('delivers text frames as strings and binary frames as bytes', async () => {
    const socket = await connectWebSocket(await echoServer());
    const got: (string | Uint8Array)[] = [];
    socket.onMessage((d) => got.push(d));
    socket.send('hello');
    socket.send(new Uint8Array([1, 2, 3]));
    await expect.poll(() => got.length).toBe(2);
    expect(got[0]).toBe('hello');
    expect(typeof got[1]).not.toBe('string');
    expect([...(got[1] as Uint8Array)]).toEqual([1, 2, 3]);
    socket.close();
  });

  it('stops delivering while reading is paused and delivers once resumed', async () => {
    const socket = await connectWebSocket(await echoServer());
    const got: (string | Uint8Array)[] = [];
    socket.onMessage((d) => got.push(d));
    socket.pauseReading();
    socket.send('while paused');
    await new Promise((r) => setTimeout(r, 150));
    expect(got).toHaveLength(0);
    socket.resumeReading();
    await expect.poll(() => got.length).toBe(1);
    socket.close();
  });

  it('reports the close code and rejects when nothing is listening', async () => {
    const url = await echoServer();
    const socket = await connectWebSocket(url);
    const closed = new Promise<number>((resolve) => socket.onClose(resolve));
    socket.close(1000);
    expect(await closed).toBe(1000);
    await expect(connectWebSocket('ws://127.0.0.1:1')).rejects.toBeDefined();
  });
});

describe('accessHeaders', () => {
  it('returns both service-token headers when both halves are set', () => {
    expect(accessHeaders({ CF_ACCESS_CLIENT_ID: 'id.access', CF_ACCESS_CLIENT_SECRET: 's3cret' })).toEqual({
      'CF-Access-Client-Id': 'id.access',
      'CF-Access-Client-Secret': 's3cret',
    });
  });

  it('returns no headers when either half is missing or empty', () => {
    expect(accessHeaders({})).toEqual({});
    expect(accessHeaders({ CF_ACCESS_CLIENT_ID: 'id.access' })).toEqual({});
    expect(accessHeaders({ CF_ACCESS_CLIENT_ID: 'id.access', CF_ACCESS_CLIENT_SECRET: '' })).toEqual({});
  });
});

describe('webSocketConnector', () => {
  it('sends the given headers with the upgrade request', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const upgrade = new Promise<Record<string, string | string[] | undefined>>((resolve) =>
      server.once('connection', (_ws, req) => resolve(req.headers)),
    );
    const connect = webSocketConnector({ 'CF-Access-Client-Id': 'id.access', 'CF-Access-Client-Secret': 's3cret' });
    const socket = await connect(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const headers = await upgrade;
    expect(headers['cf-access-client-id']).toBe('id.access');
    expect(headers['cf-access-client-secret']).toBe('s3cret');
    socket.close();
  });
});
