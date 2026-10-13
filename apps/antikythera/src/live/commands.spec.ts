import { describe, expect, it, vi } from 'vitest';
import { CommandTracker } from './commands.js';

const owner = (): object => ({});

describe('CommandTracker', () => {
  it('tracks a command from start to finish, once', () => {
    const t = new CommandTracker();
    expect(t.start('a:1', owner())).toBe(true);
    expect(t.start('a:1', owner())).toBe(false);
    expect(t.size).toBe(1);
    expect(t.finish('a:1')).toBe(true);
    expect(t.finish('a:1')).toBe(false);
    expect(t.size).toBe(0);
  });

  it('runs an ack when the store reaches the version, and not before', () => {
    const t = new CommandTracker();
    const ack = vi.fn();
    t.waitForVersion('a:1', 'O1', 5, 1_000, ack);
    expect(t.release(() => 4, 10)).toBe(0);
    expect(t.release(() => undefined, 10)).toBe(0);
    expect(ack).not.toHaveBeenCalled();
    expect(t.release((id) => (id === 'O1' ? 5 : 0), 10)).toBe(1);
    expect(ack).toHaveBeenCalledOnce();
    expect(t.release(() => 9, 10)).toBe(0);
  });

  it('runs an ack whose deadline has passed even if the version never arrived', () => {
    const t = new CommandTracker();
    const ack = vi.fn();
    t.waitForVersion('a:1', 'O1', 5, 100, ack);
    expect(t.release(() => 0, 99)).toBe(0);
    expect(t.release(() => 0, 100)).toBe(1);
    expect(ack).toHaveBeenCalledOnce();
  });

  it('drops the commands of one owner without touching the others', () => {
    const t = new CommandTracker();
    const a = owner();
    const b = owner();
    t.start('a:1', a);
    t.start('a:2', a);
    t.start('b:1', b);
    expect(t.dropOwner(a)).toBe(2);
    expect(t.size).toBe(1);
    expect(t.finish('b:1')).toBe(true);
  });

  it('clears everything', () => {
    const t = new CommandTracker();
    const ack = vi.fn();
    t.start('a:1', owner());
    t.waitForVersion('a:1', 'O1', 1, 0, ack);
    t.clear();
    expect(t.size).toBe(0);
    expect(t.release(() => 9, 1)).toBe(0);
  });
});
