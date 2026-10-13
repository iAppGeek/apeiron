import { deriveOverlay, isOpen, type CurrencyPair, type Order, type OrderStateRecord, type PriceTick } from '@apeiron/logos';

export type Expected = {
  order: Order;
  /** Fields a comparison must ignore, and why: see {@link OrderModel.expected}. */
  excluded: ReadonlySet<string>;
};

/**
 * The independent model of the final state: the open orders the run started from, with every record the order service
 * publishes applied (the newest version of each order wins) and the latest tick per pair remembered. It uses nothing
 * from the blotter; the price overlay is the shared logos function.
 */
export class OrderModel {
  private readonly orders = new Map<string, Order>();
  private readonly versions = new Map<string, number>();
  private readonly touched = new Set<string>();
  private readonly created: string[] = [];
  private readonly ticks = new Map<CurrencyPair, PriceTick>();
  private recordCount = 0;

  constructor(initial: readonly Order[]) {
    for (const order of initial) this.orders.set(order.orderId, { ...order });
  }

  /** Applies a record from `ORDER_STATE`. An order never seen before is a new one; a version not above the held one is ignored. */
  applyRecord(record: OrderStateRecord): void {
    const id = record.order.orderId;
    const held = this.versions.get(id);
    if (held !== undefined && held >= record.v) return;
    this.versions.set(id, record.v);
    this.recordCount += 1;
    if (!this.orders.has(id)) this.created.push(id);
    this.orders.set(id, { ...record.order });
    this.touched.add(id);
  }

  applyTick(tick: PriceTick): void {
    this.ticks.set(tick.pair, tick);
  }

  /** How many records changed the model. */
  get events(): number {
    return this.recordCount;
  }

  /** Ids of orders the stream created, in creation order (ascending). */
  get createdIds(): readonly string[] {
    return this.created;
  }

  /** Ids of orders any record touched. */
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
