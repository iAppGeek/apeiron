import { ORDER_STATUSES, type OrderStatus } from '@apeiron/logos';

export type StatusSummary = { byStatus: Record<OrderStatus, number>; liveNotionalUsd: number };

const emptyCounts = (): Record<OrderStatus, number> =>
  Object.fromEntries(ORDER_STATUSES.map((s): [OrderStatus, number] => [s, 0])) as Record<OrderStatus, number>;

const ALL = 'ALL';

/**
 * Running order counts by status, and the USD notional of LIVE orders, per trader and overall. Updated
 * from each row change, so the once-a-second summary costs nothing to compute.
 */
export class StatusCounters {
  private readonly byTrader = new Map<string, { counts: Record<OrderStatus, number>; liveNotional: number }>();

  /** Adds (`sign` 1) or removes (`sign` -1) one order's contribution. */
  apply(traderId: string, status: OrderStatus, notionalUsd: number, sign: 1 | -1): void {
    for (const key of [traderId, ALL]) {
      let t = this.byTrader.get(key);
      if (t === undefined) {
        t = { counts: emptyCounts(), liveNotional: 0 };
        this.byTrader.set(key, t);
      }
      t.counts[status] += sign;
      if (status === 'LIVE' && notionalUsd === notionalUsd) t.liveNotional += sign * notionalUsd;
    }
  }

  /** Counts for one trader, or for everyone with `'ALL'`. */
  scoped(traderId: string): StatusSummary {
    const t = this.byTrader.get(traderId);
    if (t === undefined) return { byStatus: emptyCounts(), liveNotionalUsd: 0 };
    return { byStatus: { ...t.counts }, liveNotionalUsd: t.liveNotional };
  }

  clear(): void {
    this.byTrader.clear();
  }
}
