import type { ErrorCode } from '@apeiron/logos';

/** How a command ended: applied (the client gets `ack`) or failed (the client gets `error`). */
export type CommandOutcome = { ok: true } | { ok: false; code: ErrorCode; message: string };

type Pending = { owner: object; settle: (outcome: CommandOutcome) => void; timer: ReturnType<typeof setTimeout> };

export const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;

/**
 * Remembers the commands that are waiting for hermes, keyed by `commandId`. Each is settled exactly once:
 * by the matching UPDATE or REJECT, by the timeout, or silently when its owner (a session) goes away.
 */
export class CommandCorrelator {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS) {}

  get size(): number {
    return this.pending.size;
  }

  has(commandId: string): boolean {
    return this.pending.has(commandId);
  }

  /** Starts waiting. Returns false (and does not register) when the id is already pending. */
  register(commandId: string, owner: object, settle: (outcome: CommandOutcome) => void): boolean {
    if (this.pending.has(commandId)) return false;
    const timer = setTimeout(() => {
      this.resolve(commandId, { ok: false, code: 'INTERNAL', message: 'command timed out' });
    }, this.timeoutMs);
    this.pending.set(commandId, { owner, settle, timer });
    return true;
  }

  /** Settles a pending command. Returns false when nothing is waiting for that id (already settled, timed out, or another process's). */
  resolve(commandId: string, outcome: CommandOutcome): boolean {
    const entry = this.pending.get(commandId);
    if (entry === undefined) return false;
    clearTimeout(entry.timer);
    this.pending.delete(commandId);
    entry.settle(outcome);
    return true;
  }

  /** Forgets every command owned by `owner` without settling it. Returns how many were dropped. */
  dropOwner(owner: object): number {
    let dropped = 0;
    for (const [id, entry] of this.pending) {
      if (entry.owner !== owner) continue;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      dropped++;
    }
    return dropped;
  }

  clear(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
  }
}
