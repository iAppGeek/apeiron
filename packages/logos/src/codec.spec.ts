import { describe, expect, it } from 'vitest';
import { getCodec, jsonCodec, msgpackCodec, type Codec } from './codec.js';
import { sampleMessages, sampleServerMsgs } from './fixtures.js';
import { SERVER_MSG_TYPES } from './protocol.js';

describe.each<[string, Codec]>([
  ['json', jsonCodec],
  ['msgpack', msgpackCodec],
])('%s codec', (_name, codec) => {
  it('round-trips every message type', () => {
    for (const msg of sampleMessages()) {
      const encoded = codec.encode(msg);
      expect(codec.decode(encoded)).toEqual(msg);
    }
  });

  it('covers every ServerMsg type in the fixtures', () => {
    const types = new Set(sampleServerMsgs().map((m) => m.t));
    for (const t of SERVER_MSG_TYPES) expect(types.has(t)).toBe(true);
  });

  it('produces frames matching its binary flag', () => {
    const frame = codec.encode({ t: 'ping', ts: 1 });
    expect(typeof frame === 'string').toBe(!codec.binary);
  });

  it('decodes ArrayBuffer input', () => {
    const frame = codec.encode({ t: 'pong', ts: 1, serverTs: 2 });
    const bytes = typeof frame === 'string' ? new TextEncoder().encode(frame) : frame;
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    expect(codec.decode(buf)).toEqual({ t: 'pong', ts: 1, serverTs: 2 });
  });
});

describe('codec specifics', () => {
  it('json decodes binary UTF-8 frames and rejects invalid text', () => {
    expect(jsonCodec.decode(new TextEncoder().encode('{"t":"ack","reqId":1}'))).toEqual({ t: 'ack', reqId: 1 });
    expect(() => jsonCodec.decode('not json')).toThrow();
  });

  it('msgpack rejects text frames', () => {
    expect(() => msgpackCodec.decode('{"t":"ack"}')).toThrow(/text frame/);
  });

  it('msgpack is smaller than json for a block of rows', () => {
    const rows = sampleServerMsgs()[1]!;
    const json = jsonCodec.encode(rows) as string;
    const mp = msgpackCodec.encode(rows) as Uint8Array;
    expect(mp.byteLength).toBeLessThan(json.length);
  });

  it('getCodec picks the implementation by name', () => {
    expect(getCodec('json')).toBe(jsonCodec);
    expect(getCodec('msgpack')).toBe(msgpackCodec);
  });
});
