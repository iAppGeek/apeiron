import { decode as msgpackDecode, encode as msgpackEncode } from '@msgpack/msgpack';
import type { CodecName, Message } from './protocol.js';

export type WireData = string | Uint8Array | ArrayBuffer;

/**
 * Wire format. The first frame (`hello`) is always JSON text; every later frame uses the negotiated
 * codec: text frames for JSON, binary frames for msgpack.
 */
export type Codec = {
  readonly name: CodecName;
  /** True when frames are binary (WebSocket binary frames). */
  readonly binary: boolean;
  encode(msg: Message): string | Uint8Array;
  decode(data: WireData): unknown;
};

const textDecoder = new TextDecoder();

export const jsonCodec: Codec = {
  name: 'json',
  binary: false,
  encode: (msg: Message): string => JSON.stringify(msg),
  decode: (data: WireData): unknown => {
    if (typeof data === 'string') return JSON.parse(data);
    return JSON.parse(textDecoder.decode(data));
  },
};

export const msgpackCodec: Codec = {
  name: 'msgpack',
  binary: true,
  encode: (msg: Message): Uint8Array => msgpackEncode(msg),
  decode: (data: WireData): unknown => {
    if (typeof data === 'string') throw new Error('msgpack codec cannot decode a text frame');
    return msgpackDecode(data);
  },
};

export function getCodec(name: CodecName): Codec {
  return name === 'msgpack' ? msgpackCodec : jsonCodec;
}
