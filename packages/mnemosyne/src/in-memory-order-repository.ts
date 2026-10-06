import type { Order } from '@apeiron/logos';
import { DEFAULT_BATCH_SIZE, type OrderRepository } from './order-repository.js';

/** In-memory fake used by unit tests of services that depend on {@link OrderRepository}. */
export class InMemoryOrderRepository implements OrderRepository {
  private readonly orders = new Map<string, Order>();

  async *loadAll(batchSize: number = DEFAULT_BATCH_SIZE): AsyncGenerator<Order[]> {
    const ids = [...this.orders.keys()].sort();
    for (let i = 0; i < ids.length; i += batchSize) {
      yield ids.slice(i, i + batchSize).map((id) => structuredClone(this.orders.get(id) as Order));
    }
  }

  upsertMany(orders: readonly Order[]): Promise<void> {
    for (const order of orders) this.orders.set(order.orderId, structuredClone(order));
    return Promise.resolve();
  }

  count(): Promise<number> {
    return Promise.resolve(this.orders.size);
  }

  clear(): Promise<void> {
    this.orders.clear();
    return Promise.resolve();
  }

  isSeeded(): Promise<boolean> {
    return Promise.resolve(this.orders.size > 0);
  }
}
