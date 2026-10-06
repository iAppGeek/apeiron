import { describe, expect, it } from 'vitest';
import { fail, ok } from './errors.js';

describe('Result helpers', () => {
  it('wraps values and failures', () => {
    expect(ok(5)).toEqual({ ok: true, value: 5 });
    expect(fail('BAD_REQUEST', 'nope')).toEqual({ ok: false, code: 'BAD_REQUEST', message: 'nope' });
  });
});
