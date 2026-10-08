import { jsonCodec, type ClientMsg, type ServerMsg } from '@apeiron/logos';
import { describe, expect, it } from 'vitest';
import { openReader } from './ws-client';

class FakeSocket {
  binaryType = 'blob';
  sent: ClientMsg[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  send(data: string): void {
    const msg = jsonCodec.decode(data) as ClientMsg;
    this.sent.push(msg);
    if (msg.t === 'hello') this.reply({ t: 'welcome', serverTime: Date.now() + 1500, traders: [], columnsVersion: 'x', preset: null });
    if (msg.t === 'getRows') {
      this.reply(
        msg.req.startRow === 99
          ? { t: 'error', reqId: msg.reqId, code: 'INTERNAL', message: 'boom' }
          : { t: 'rows', reqId: msg.reqId, rows: [{ orderId: 'A' }], rowCount: 7, ms: 1 },
      );
    }
  }
  reply(msg: ServerMsg): void {
    queueMicrotask(() => this.onmessage?.({ data: jsonCodec.encode(msg) }));
  }
  close(): void {
    this.closed = true;
  }
}

const open = async (): Promise<{ socket: FakeSocket; reader: Awaited<ReturnType<typeof openReader>> }> => {
  const socket = new FakeSocket();
  const pending = openReader({ socket: () => socket as unknown as WebSocket, traderId: 'T2' });
  queueMicrotask(() => socket.onopen?.());
  return { socket, reader: await pending };
};

describe('openReader', () => {
  it('says hello as the requested trader and measures the server clock offset', async () => {
    const { socket, reader } = await open();
    expect(socket.sent[0]).toMatchObject({ t: 'hello', traderId: 'T2', codec: 'json' });
    expect(reader.serverOffsetMs).toBeGreaterThan(1000);
    expect(reader.serverOffsetMs).toBeLessThan(2000);
  });

  it('matches getRows replies by reqId and rejects an error reply', async () => {
    const { reader } = await open();
    const req = { startRow: 0, endRow: 1, rowGroupCols: [], valueCols: [], groupKeys: [], sortModel: [] };
    await expect(reader.getRows(req)).resolves.toEqual({ rows: [{ orderId: 'A' }], rowCount: 7 });
    await expect(reader.getRows({ ...req, startRow: 99 })).rejects.toThrow('INTERNAL: boom');
  });

  it('resolves nextSummary with the next summary message', async () => {
    const { socket, reader } = await open();
    const next = reader.nextSummary();
    const summary: ServerMsg = {
      t: 'summary',
      byStatus: { PENDING_START: 1, LIVE: 2, PAUSED: 0, FILLED: 3, CANCELLED: 0 },
      liveNotionalUsd: 5,
      totalRows: 6,
      server: { cpu: 0, rssMb: 0, elLagMs: 0 },
      preset: null,
    };
    socket.reply(summary);
    await expect(next).resolves.toMatchObject({ totalRows: 6 });
  });

  it('rejects pending requests when the socket closes, and closes quietly on request', async () => {
    const { socket, reader } = await open();
    const req = { startRow: 99, endRow: 100, rowGroupCols: [], valueCols: [], groupKeys: [], sortModel: [] };
    socket.send = (): void => undefined;
    const pending = reader.getRows(req);
    socket.onclose?.();
    await expect(pending).rejects.toThrow('closed');
    const second = await open();
    second.reader.close();
    expect(second.socket.closed).toBe(true);
  });
});
