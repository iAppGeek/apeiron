import type { FailureCode } from '../transport/messages';

/** A short, user-facing explanation for every failure the transport or server can report. */
export function describeFailure(code: FailureCode, serverMessage?: string): string {
  switch (code) {
    case 'UNSUPPORTED_FILTER':
      return 'That filter is not supported by the server.';
    case 'UNSUPPORTED_AGG':
      return 'That aggregation is not supported by the server.';
    case 'UNSUPPORTED_PIVOT':
      return 'Pivot mode is not supported.';
    case 'UNSUPPORTED_GROUP':
      return 'That column cannot be grouped.';
    case 'UNSUPPORTED_COLUMN':
      return 'That column is not supported by the server.';
    case 'UNKNOWN_COLUMN':
      return 'The server does not know that column.';
    case 'UNKNOWN_TRADER':
      return 'The server does not know that trader.';
    case 'BAD_REQUEST':
    case 'BAD_FRAME':
    case 'BAD_MESSAGE':
      return `The server rejected a malformed request${serverMessage ? `: ${serverMessage}` : '.'}`;
    case 'HELLO_REQUIRED':
      return 'The session was not initialised; reconnecting.';
    case 'NOT_READY':
      return 'The server is still loading orders.';
    case 'NOT_IMPLEMENTED':
      return 'The server does not implement that yet.';
    case 'INTERNAL':
      return 'The server hit an internal error.';
    case 'INVALID_TRANSITION':
      return 'That action is not allowed in the order’s current state.';
    case 'UNKNOWN_ORDER':
      return 'The server does not know that order.';
    case 'SLOW_CONSUMER':
      return 'The connection fell too far behind and was closed by the server.';
    case 'DISCONNECTED':
      return 'The connection to the server was lost.';
    case 'TIMEOUT':
      return 'The server did not answer in time.';
  }
}

/** Failures the datasource waits out instead of reporting: the server or the link is not ready yet. */
export function isRetryable(code: FailureCode): boolean {
  return code === 'NOT_READY' || code === 'DISCONNECTED';
}
