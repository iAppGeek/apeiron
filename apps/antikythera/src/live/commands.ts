import type { ErrorCode } from '@apeiron/logos';

/** How a command ended: applied (the client gets `ack`) or failed (the client gets `error`). */
export type CommandOutcome = { ok: true } | { ok: false; code: ErrorCode; message: string };

export const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
/** After the order service has accepted a command, the blotter acks once its store holds that version, or after this long. */
export const DEFAULT_ACK_WAIT_V_MS = 2_000;

type Waiting = { commandId: string; orderId: string; v: number; deadline: number; ack: () => void };

/**
 * The commands this blotter has sent and not finished with. A command is in flight from the request until it is
 * settled; once the order service has accepted it, it waits for the store to reach the version the service replied with
 * (so the client sees the change before its ack), at most until a deadline. A session that goes away takes its commands
 * with it: their outcomes are dropped.
 */
export class CommandTracker {
  private readonly inflight = new Map<string, object>();
  private waiting: Waiting[] = [];

  /** How many commands are in flight. */
  get size(): number {
    return this.inflight.size;
  }

  /** Starts tracking. Returns false (and does not track) when the id is already in flight. */
  start(commandId: string, owner: object): boolean {
    if (this.inflight.has(commandId)) return false;
    this.inflight.set(commandId, owner);
    return true;
  }

  /** Ends tracking. Returns false when the command is no longer tracked (settled already, or its owner went away). */
  finish(commandId: string): boolean {
    return this.inflight.delete(commandId);
  }

  /** Holds `ack` until `versionOf(orderId) >= v` or `deadline` passes. */
  waitForVersion(commandId: string, orderId: string, v: number, deadline: number, ack: () => void): void {
    this.waiting.push({ commandId, orderId, v, deadline, ack });
  }

  /** Runs the acks whose version has been reached or whose deadline has passed. Returns how many ran. */
  release(versionOf: (orderId: string) => number | undefined, now: number): number {
    if (this.waiting.length === 0) return 0;
    const due: Waiting[] = [];
    this.waiting = this.waiting.filter((w) => {
      const reached = (versionOf(w.orderId) ?? 0) >= w.v;
      if (reached || now >= w.deadline) {
        due.push(w);
        return false;
      }
      return true;
    });
    for (const w of due) w.ack();
    return due.length;
  }

  /** Forgets every command owned by `owner` without settling it. Returns how many were dropped. */
  dropOwner(owner: object): number {
    let dropped = 0;
    for (const [id, o] of this.inflight) {
      if (o !== owner) continue;
      this.inflight.delete(id);
      dropped++;
    }
    return dropped;
  }

  clear(): void {
    this.inflight.clear();
    this.waiting = [];
  }
}
