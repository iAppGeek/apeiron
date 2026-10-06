import { describe, expect, it } from 'vitest';
import { sampleClientMsgs, sampleServerMsgs } from './fixtures.js';
import { clientMsgSchema, isServerMsg, parseClientMsg } from './protocol.js';

describe('parseClientMsg', () => {
  it('accepts every client message type', () => {
    for (const msg of sampleClientMsgs()) {
      const result = parseClientMsg(msg);
      expect(result).toEqual({ ok: true, value: msg });
    }
  });

  it('rejects unknown types and malformed payloads with a readable error', () => {
    const bad: unknown[] = [
      null,
      'hello',
      { t: 'nope' },
      { t: 'hello', traderId: '', codec: 'json', clientId: 'c' },
      { t: 'hello', traderId: 'T1', codec: 'xml', clientId: 'c' },
      { t: 'getRows', reqId: -1, req: {} },
      { t: 'getRows', reqId: 1, req: { startRow: 0, endRow: 10, rowGroupCols: [], valueCols: [], groupKeys: [], sortModel: [{ colId: 'a', sort: 'up' }] } },
      { t: 'command', reqId: 1, orderId: 'A', action: 'DELETE' },
      { t: 'ping', ts: 'now' },
    ];
    for (const input of bad) {
      const result = parseClientMsg(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it('accepts a null filterModel and strips unknown keys', () => {
    const result = parseClientMsg({
      t: 'getRows',
      reqId: 1,
      req: { startRow: 0, endRow: 100, rowGroupCols: [], valueCols: [], groupKeys: [], sortModel: [], filterModel: null, extra: 1 },
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.t === 'getRows') expect('extra' in result.value.req).toBe(false);
  });

  it('exposes the schema', () => {
    expect(clientMsgSchema.safeParse({ t: 'ping', ts: 1 }).success).toBe(true);
  });
});

describe('isServerMsg', () => {
  it('recognises every server message type', () => {
    for (const msg of sampleServerMsgs()) expect(isServerMsg(msg)).toBe(true);
  });

  it('rejects other values', () => {
    for (const v of [null, 1, 'x', {}, { t: 'hello' }, { t: 5 }]) expect(isServerMsg(v)).toBe(false);
  });
});
