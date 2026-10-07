/** Orders with a command in flight, so the grid can show an in-progress indicator on their rows. */
export type PendingCommands = {
  /** Marks a command as sent. Several commands on one order are counted. */
  begin(orderId: string): void;
  /** Marks one command as finished (acked or failed). */
  end(orderId: string): void;
  has(orderId: string): boolean;
  /** `listener` is called with the order id whenever its pending state changes. Returns an unsubscribe function. */
  subscribe(listener: (orderId: string) => void): () => void;
};

export function createPendingCommands(): PendingCommands {
  const counts = new Map<string, number>();
  const listeners = new Set<(orderId: string) => void>();
  const notify = (orderId: string): void => {
    for (const listener of [...listeners]) listener(orderId);
  };
  return {
    begin(orderId: string): void {
      counts.set(orderId, (counts.get(orderId) ?? 0) + 1);
      notify(orderId);
    },
    end(orderId: string): void {
      const n = counts.get(orderId);
      if (n === undefined) return;
      if (n <= 1) counts.delete(orderId);
      else counts.set(orderId, n - 1);
      notify(orderId);
    },
    has: (orderId: string): boolean => counts.has(orderId),
    subscribe(listener: (orderId: string) => void): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
  };
}
