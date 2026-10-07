import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandCorrelator, DEFAULT_COMMAND_TIMEOUT_MS, type CommandOutcome } from './commands.js';

afterEach(() => {
  vi.useRealTimers();
});

const owner = (): object => ({});

describe('CommandCorrelator', () => {
  it('settles a pending command once, on resolve', () => {
    const c = new CommandCorrelator();
    const settle = vi.fn<(o: CommandOutcome) => void>();
    expect(c.register('a:1', owner(), settle)).toBe(true);
    expect(c.has('a:1')).toBe(true);
    expect(c.resolve('a:1', { ok: true })).toBe(true);
    expect(settle).toHaveBeenCalledExactlyOnceWith({ ok: true });
    expect(c.resolve('a:1', { ok: true })).toBe(false);
    expect(c.size).toBe(0);
    c.clear();
  });

  it('refuses a duplicate command id and ignores unknown ones', () => {
    const c = new CommandCorrelator();
    expect(c.register('a:1', owner(), vi.fn())).toBe(true);
    expect(c.register('a:1', owner(), vi.fn())).toBe(false);
    expect(c.resolve('other:9', { ok: true })).toBe(false);
    c.clear();
  });

  it('times out with INTERNAL "command timed out"', () => {
    vi.useFakeTimers();
    const c = new CommandCorrelator();
    const settle = vi.fn<(o: CommandOutcome) => void>();
    c.register('a:1', owner(), settle);
    vi.advanceTimersByTime(DEFAULT_COMMAND_TIMEOUT_MS - 1);
    expect(settle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(settle).toHaveBeenCalledExactlyOnceWith({ ok: false, code: 'INTERNAL', message: 'command timed out' });
    expect(c.size).toBe(0);
  });

  it('honours a custom timeout and does not time out once settled', () => {
    vi.useFakeTimers();
    const c = new CommandCorrelator(100);
    const settle = vi.fn<(o: CommandOutcome) => void>();
    c.register('a:1', owner(), settle);
    c.resolve('a:1', { ok: false, code: 'UNKNOWN_ORDER', message: 'gone' });
    vi.advanceTimersByTime(1_000);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('drops everything an owner has pending without settling it', () => {
    vi.useFakeTimers();
    const c = new CommandCorrelator(100);
    const mine = owner();
    const theirs = owner();
    const settleMine = vi.fn();
    const settleTheirs = vi.fn();
    c.register('a:1', mine, settleMine);
    c.register('a:2', mine, settleMine);
    c.register('b:1', theirs, settleTheirs);
    expect(c.dropOwner(mine)).toBe(2);
    vi.advanceTimersByTime(1_000);
    expect(settleMine).not.toHaveBeenCalled();
    expect(settleTheirs).toHaveBeenCalledTimes(1);
  });

  it('clear forgets all pending commands and their timers', () => {
    vi.useFakeTimers();
    const c = new CommandCorrelator(100);
    const settle = vi.fn();
    c.register('a:1', owner(), settle);
    c.clear();
    vi.advanceTimersByTime(1_000);
    expect(settle).not.toHaveBeenCalled();
    expect(c.size).toBe(0);
  });
});
