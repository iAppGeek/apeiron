import { ERROR_CODES } from '@apeiron/logos';
import { describe, expect, it } from 'vitest';
import type { FailureCode } from '../transport/messages';
import { describeCommandFailure, describeFailure, isRetryable } from './errors';

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
  it('waits out NOT_READY, DISCONNECTED and TIMEOUT only', () => {
    expect(isRetryable('NOT_READY')).toBe(true);
    expect(isRetryable('DISCONNECTED')).toBe(true);
    expect(isRetryable('UNSUPPORTED_FILTER')).toBe(false);
    expect(isRetryable('TIMEOUT')).toBe(true);
    expect(isRetryable('INTERNAL')).toBe(false);
  });
});

describe('describeCommandFailure', () => {
  it('names the action and order for every code', () => {
    const codes: FailureCode[] = [...ERROR_CODES, 'DISCONNECTED', 'TIMEOUT'];
    for (const code of codes) {
      const text = describeCommandFailure(code, 'PAUSE', 'ALG00000007', 'detail');
      expect(text).toContain('Pause failed for ALG00000007');
      expect(text.length).toBeGreaterThan(30);
    }
  });

  it('quotes the server reason for INVALID_TRANSITION and falls back without one', () => {
    expect(describeCommandFailure('INVALID_TRANSITION', 'CANCEL', 'ALG1', 'Cannot cancel an order that is FILLED')).toBe(
      'Cancel failed for ALG1: Cannot cancel an order that is FILLED.',
    );
    expect(describeCommandFailure('INVALID_TRANSITION', 'CANCEL', 'ALG1')).toContain('not allowed');
  });

  it('explains an unknown order, a timed-out command and a lost connection', () => {
    expect(describeCommandFailure('UNKNOWN_ORDER', 'RESUME', 'ALG1')).toContain('no longer active');
    expect(describeCommandFailure('INTERNAL', 'RESUME', 'ALG1', 'command timed out')).toContain('did not answer in time');
    expect(describeCommandFailure('INTERNAL', 'RESUME', 'ALG1', 'boom')).toContain('internal error');
    expect(describeCommandFailure('DISCONNECTED', 'PAUSE', 'ALG1')).toContain('connection');
    expect(describeCommandFailure('NOT_IMPLEMENTED', 'PAUSE', 'ALG1')).toContain('does not implement');
  });
});
