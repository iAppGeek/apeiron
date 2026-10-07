import { describe, expect, it, vi } from 'vitest';
import { createPendingCommands } from './pending-commands';

describe('createPendingCommands', () => {
  it('tracks an order from begin to end and notifies on each change', () => {
    const pending = createPendingCommands();
    const listener = vi.fn();
    pending.subscribe(listener);
    expect(pending.has('A')).toBe(false);
    pending.begin('A');
    expect(pending.has('A')).toBe(true);
    pending.end('A');
    expect(pending.has('A')).toBe(false);
    expect(listener.mock.calls).toEqual([['A'], ['A']]);
  });

  it('counts overlapping commands on one order', () => {
    const pending = createPendingCommands();
    pending.begin('A');
    pending.begin('A');
    pending.end('A');
    expect(pending.has('A')).toBe(true);
    pending.end('A');
    expect(pending.has('A')).toBe(false);
  });

  it('ignores an end without a begin and stops notifying after unsubscribe', () => {
    const pending = createPendingCommands();
    const listener = vi.fn();
    const off = pending.subscribe(listener);
    pending.end('A');
    expect(listener).not.toHaveBeenCalled();
    off();
    pending.begin('A');
    expect(listener).not.toHaveBeenCalled();
  });
});
