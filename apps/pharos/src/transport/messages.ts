import type { ClientMsg, CodecName, ErrorCode, ServerMsg } from '@apeiron/logos';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed';

/** Client messages that carry a `reqId` and get exactly one response. */
export type RequestMsg = Extract<ClientMsg, { reqId: number }>;

export type WelcomeMsg = Extract<ServerMsg, { t: 'welcome' }>;

/** Why a request or hello did not complete. The server codes pass through unchanged. */
export type FailureCode = ErrorCode | 'DISCONNECTED' | 'TIMEOUT';
export type Failure = { code: FailureCode; message: string };

/** Main thread to worker. */
export type MainToWorker =
  | { kind: 'connect'; url: string }
  | { kind: 'hello'; id: number; traderId: string; codec: CodecName }
  | { kind: 'request'; msg: RequestMsg }
  | { kind: 'close' };

/** Worker to main thread. Every payload is a plain structured-cloneable value. */
export type WorkerToMain =
  | { kind: 'status'; status: ConnectionStatus; attempt: number; codec: CodecName }
  | ({ kind: 'hello-result'; id: number } & ({ ok: true; welcome: WelcomeMsg } | ({ ok: false } & Failure)))
  | ({ kind: 'response'; reqId: number } & ({ ok: true; msg: ServerMsg } | ({ ok: false } & Failure)))
  /** Every server message that is not the answer to a request (delta, summary, welcome, stray errors). */
  | { kind: 'message'; msg: ServerMsg }
  | { kind: 'stats'; msgsIn: number; msgsOut: number; rttMs: number | null };
