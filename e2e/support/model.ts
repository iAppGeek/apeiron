import { derivePriceFields, isOpen, type CurrencyPair, type Order, type OrderEvent, type PriceTick } from '@apeiron/logos';

/** Fields the server fills from its own clock or from a quote race, which a model cannot reproduce for a closed order. */
export const SERVER_CLOCK_FIELDS: readonly (keyof Order)[] = ['lastUpdateTime'];
export const QUOTE_FIELDS: readonly (keyof Order)[] = ['marketBid', 'marketAsk', 'marketMid', 'spreadBps', 'distanceToLimitBps'];

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
   * - An open order (LIVE or PAUSED) was repriced from the latest tick of its pair, whatever else happened, so the
   *   model applies the same logos function to that tick. Only `lastUpdateTime` (the server's clock) is ignored.
   * - A closed or pending order is not repriced. Its quote fields depend on whether a tick landed on the server
   *   before or after its closing event within one flush, which no model can know, so those five fields are ignored too.
   */
  expected(orderId: string): Expected | undefined {
    const base = this.orders.get(orderId);
    if (base === undefined) return undefined;
    const excluded = new Set<string>(SERVER_CLOCK_FIELDS);
    const tick = this.ticks.get(base.currencyPair);
    if (isOpen(base.status)) {
      if (tick === undefined) return { order: base, excluded };
      return { order: { ...base, ...derivePriceFields(base, tick, base.lastUpdateTime) }, excluded };
    }
    for (const field of QUOTE_FIELDS) excluded.add(field);
    return { order: base, excluded };
  }

  /** Orders to read back from the server: everything an event touched, plus every open order (repriced by ticks). */
  idsToVerify(): string[] {
    const ids = new Set<string>(this.touched);
    for (const order of this.orders.values()) if (isOpen(order.status) && this.ticks.has(order.currencyPair)) ids.add(order.orderId);
    return [...ids];
  }
}
