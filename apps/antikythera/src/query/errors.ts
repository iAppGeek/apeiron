/** Error codes the engine can return to a client. `UNSUPPORTED_FILTER` and `UNSUPPORTED_AGG` come from Appendix B. */
export type EngineErrorCode =
  | 'UNSUPPORTED_FILTER'
  | 'UNSUPPORTED_AGG'
  | 'UNSUPPORTED_PIVOT'
  | 'UNSUPPORTED_GROUP'
  | 'UNSUPPORTED_COLUMN'
  | 'UNKNOWN_COLUMN'
  | 'BAD_REQUEST';

export type EngineFailure = { ok: false; code: EngineErrorCode; message: string };
export type Result<T> = { ok: true; value: T } | EngineFailure;

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = (code: EngineErrorCode, message: string): EngineFailure => ({ ok: false, code, message });
