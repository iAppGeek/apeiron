import { ERROR_CODES } from '@apeiron/logos';
import { describe, expect, it } from 'vitest';
import type { FailureCode } from '../transport/messages';
import { describeFailure, isRetryable } from './errors';

describe('describeFailure', () => {
  it('has a non-empty message for every server error code and transport code', () => {
    const codes: FailureCode[] = [...ERROR_CODES, 'DISCONNECTED', 'TIMEOUT'];
    for (const code of codes) {
      expect(describeFailure(code, 'detail').length).toBeGreaterThan(5);
    }
  });

  it('includes the server message for malformed requests', () => {
    expect(describeFailure('BAD_REQUEST', 'endRow too big')).toContain('endRow too big');
    expect(describeFailure('BAD_REQUEST')).toMatch(/malformed request\.$/);
  });
});

describe('isRetryable', () => {
  it('waits out NOT_READY and DISCONNECTED only', () => {
    expect(isRetryable('NOT_READY')).toBe(true);
    expect(isRetryable('DISCONNECTED')).toBe(true);
    expect(isRetryable('UNSUPPORTED_FILTER')).toBe(false);
    expect(isRetryable('TIMEOUT')).toBe(false);
    expect(isRetryable('INTERNAL')).toBe(false);
  });
});
