import type { Order } from '@apeiron/logos';
import { ChangeSet } from '../query/changeset.js';
import type { QueryEngine } from '../query/engine.js';
import type { ViewChanges } from '../query/view.js';
import type { ColumnarStore } from '../store/columnar-store.js';

/** Applies orders to the store the way a flush tick does (upsert, ChangeSet) and patches the engine's views. */
export function applyOrders(store: ColumnarStore, engine: QueryEngine, orders: readonly Order[]): { cs: ChangeSet; changes: ViewChanges[] } {
  const cs = new ChangeSet();
  for (const order of orders) {
    const result = store.upsert(order);
    if (result.kind === 'append') cs.noteNew(result.row);
    else cs.noteUpdate(result.row, result.changed, result.prev);
  }
  return { cs, changes: engine.applyChanges(cs) };
}

/** Applies partial updates to existing rows by order id, as a flush tick would. */
export function applyUpdates(
  store: ColumnarStore,
  engine: QueryEngine,
  updates: readonly (Partial<Order> & { orderId: string })[],
): { cs: ChangeSet; changes: ViewChanges[] } {
  const cs = new ChangeSet();
  for (const update of updates) {
    const row = store.rowIndexOf(update.orderId);
    if (row === undefined) throw new Error(`unknown order ${update.orderId}`);
    const { changed, prev } = store.updateRow(row, update);
    cs.noteUpdate(row, changed, prev);
  }
  return { cs, changes: engine.applyChanges(cs) };
}
