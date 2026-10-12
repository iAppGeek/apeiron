import { deriveOverlay, isOpen, type CurrencyPair, type Order, type OrderEvent, type PriceTick } from '@apeiron/logos';

export type Expected = {
  order: Order;
  /** Fields a comparison must ignore, and why: see {@link OrderModel.expected}. */
  excluded: ReadonlySet<string>;
};

/**
 * The independent model of the final state: the orders the stream started from, with every published event applied
 * (NEW upserts, UPDATE merges its absolute fields) and the latest tick per pair remembered. It uses nothing from the
 * server; the price recompute is the shared logos function.
 */
export class OrderModel {
  private readonly orders = new Map<string, Order>();
  private readonly touched = new Set<string>();
  private readonly created: string[] = [];
  private readonly ticks = new Map<CurrencyPair, PriceTick>();
  private eventCount = 0;
  private unknownUpdates = 0;

  constructor(initial: readonly Order[]) {
    for (const order of initial) this.orders.set(order.orderId, { ...order });
  }

  applyEvent(event: OrderEvent): void {
    if (event.type === 'REJECT') return;
    this.eventCount += 1;
    if (event.type === 'NEW') {
      if (!this.orders.has(event.order.orderId)) this.created.push(event.order.orderId);
      this.orders.set(event.order.orderId, { ...event.order });
      this.touched.add(event.order.orderId);
      return;
    }
    const current = this.orders.get(event.order.orderId);
    if (current === undefined) {
      this.unknownUpdates += 1;
      return;
    }
    this.orders.set(event.order.orderId, { ...current, ...event.order });
    this.touched.add(event.order.orderId);
  }

  applyTick(tick: PriceTick): void {
    this.ticks.set(tick.pair, tick);
  }

  get events(): number {
    return this.eventCount;
  }

  get unknown(): number {
    return this.unknownUpdates;
  }

  /** Ids of orders the stream created, in creation order (ascending). */
  get createdIds(): readonly string[] {
    return this.created;
  }

  /** Ids of orders any event touched. */
  get touchedIds(): ReadonlySet<string> {
    return this.touched;
  }

  /** Every LIVE order, for the driver to pick pause targets from. */
  liveIds(): string[] {
    const out: string[] = [];
    for (const order of this.orders.values()) if (order.status === 'LIVE') out.push(order.orderId);
    return out;
  }

  statusOf(orderId: string): Order['status'] | undefined {
    return this.orders.get(orderId)?.status;
  }

  /**
   * What the server must hold for an order once everything has settled.
   * - An open order (LIVE or PAUSED) has the overlay of the latest tick of its pair, whatever else happened, so the
   *   model applies the same logos function (`deriveOverlay`) to that tick.
   * - Any other order shows exactly what its last event left: the market snapshot of the completing fill or cancel, and
   *   the `lastUpdateTime` the simulator stamped. The blotter never writes either, so nothing is excluded.
   */
  expected(orderId: string): Expected | undefined {
    const base = this.orders.get(orderId);
    if (base === undefined) return undefined;
    const excluded = new Set<string>();
    const tick = this.ticks.get(base.currencyPair);
    if (isOpen(base.status) && tick !== undefined) return { order: { ...base, ...deriveOverlay(base, tick) }, excluded };
    return { order: base, excluded };
  }

  /** Orders to read back from the server: everything an event touched, plus every open order (repriced by ticks). */
  idsToVerify(): string[] {
    const ids = new Set<string>(this.touched);
    for (const order of this.orders.values()) if (isOpen(order.status) && this.ticks.has(order.currencyPair)) ids.add(order.orderId);
    return [...ids];
  }
}
