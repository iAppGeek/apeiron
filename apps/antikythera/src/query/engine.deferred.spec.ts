import type { Order, SsrmRequest } from '@apeiron/logos';
import { describe, expect, it } from 'vitest';
import { applyUpdates } from '../testing/apply.js';
import { ChangeSet } from './changeset.js';
import { makeStore } from '../testing/orders.js';
import { QueryEngine, type EngineOptions } from './engine.js';

const base: EngineOptions = { maxViews: 50, maxBytes: 1 << 30, maxBlockRows: 10_000 };
const DATA: Partial<Order>[] = [
  { createdAt: 10, venue: 'EBS', orderQty: 1 },
  { createdAt: 20, venue: 'LMAX', orderQty: 2 },
  { createdAt: 30, venue: 'EBS', orderQty: 3 },
];
const req = (extra: Partial<SsrmRequest> = {}): SsrmRequest => ({ startRow: 0, endRow: 100, rowGroupCols: [], valueCols: [], groupKeys: [], sortModel: [], filterModel: null, ...extra });
const BY_QTY = req({ sortModel: [{ colId: 'orderQty', sort: 'asc' }] });

function setup(options: Partial<EngineOptions> = {}): { store: ReturnType<typeof makeStore>; engine: QueryEngine } {
  const store = makeStore(DATA);
  return { store, engine: new QueryEngine(store, { ...base, ...options }) };
}

const qty = (engine: QueryEngine, r: SsrmRequest): unknown[] => {
  const res = engine.getRows('ALL', r);
  if (!res.ok) throw new Error(res.code);
  return res.value.rows.map((x) => x.orderQty);
};
/** Order ids in the view's order. Values always come from the store, so only the order shows whether the view was patched. */
const ids = (engine: QueryEngine, r: SsrmRequest): unknown[] => {
  const res = engine.getRows('ALL', r);
  if (!res.ok) throw new Error(res.code);
  return res.value.rows.map((x) => x.orderId);
};

function subscribe(engine: QueryEngine, r: SsrmRequest): void {
  const res = engine.getRows('ALL', r);
  if (!res.ok) throw new Error(res.code);
  res.value.track.view.refs++;
}

describe('views nobody tracks', () => {
  it('are not patched: they are dropped to stale at the first tick and rebuilt, as a cold request, on access', () => {
    const { store, engine } = setup();
    qty(engine, BY_QTY);
    const view = [...engine.views()][0];
    expect(view?.refs).toBe(0);
    const out = applyUpdates(store, engine, [{ orderId: 'T0000001', orderQty: 50 }]);
    expect(out.changes).toHaveLength(0);
    expect(view?.stale).toBe(true);
    expect(view?.bytes).toBe(0);
    expect(engine.stats().lastApply).toMatchObject({ unsubscribed: 1, patched: 0, stale: 1 });
    const res = engine.getRows('ALL', BY_QTY);
    expect(res.ok && res.value.built).toBe(true);
    expect(res.ok && res.value.rows.map((r) => r.orderQty)).toEqual([2, 3, 50]);
    expect(view?.stale).toBe(false);
    expect(view?.bytes).toBeGreaterThan(0);
    const again = engine.getRows('ALL', BY_QTY);
    expect(again.ok && again.value.built).toBe(false);
  });

  it('keep being patched while a client tracks them', () => {
    const { store, engine } = setup();
    subscribe(engine, BY_QTY);
    const out = applyUpdates(store, engine, [{ orderId: 'T0000001', orderQty: 50 }]);
    expect(out.changes).toHaveLength(1);
    expect(engine.stats().lastApply).toMatchObject({ patched: 1, unsubscribed: 0 });
    expect(qty(engine, BY_QTY)).toEqual([2, 3, 50]);
  });

  it('go stale as soon as the last client lets go, and the idle sweep still evicts them', () => {
    const { store, engine } = setup();
    subscribe(engine, BY_QTY);
    const view = [...engine.views()][0];
    view!.refs--;
    applyUpdates(store, engine, [{ orderId: 'T0000001', orderQty: 50 }]);
    expect(view?.stale).toBe(true);
    expect(engine.sweep(0, Date.now() + 1)).toBe(1);
  });
});

describe('deferred rebuilds', () => {
  it('mark the view pending instead of rebuilding inside the tick, and serve its last state until the rebuild runs', () => {
    const { store, engine } = setup({ structuralRebuildThreshold: 1 });
    subscribe(engine, BY_QTY);
    const out = applyUpdates(store, engine, [
      { orderId: 'T0000001', orderQty: 50 },
      { orderId: 'T0000002', orderQty: 40 },
    ]);
    const view = [...engine.views()][0];
    expect(out.changes[0]?.rebuilt).toBe(false);
    expect(view?.rebuildPending).toBe(true);
    expect(engine.stats().lastApply.pendingRebuild).toBe(1);
    expect(ids(engine, BY_QTY)).toEqual(['T0000001', 'T0000002', 'T0000003']);
    const due = engine.takeRebuild(Date.now() + 5_000);
    expect(due).toBe(view);
    engine.rebuildView(due!, Date.now() + 5_000);
    expect(view?.rebuildPending).toBe(false);
    expect(qty(engine, BY_QTY)).toEqual([3, 40, 50]);
    expect(engine.stats().rebuilds).toBe(1);
  });

  it('are throttled per view to the rebuild interval', () => {
    const { store, engine } = setup({ structuralRebuildThreshold: 0, rebuildIntervalMs: 1_000 });
    subscribe(engine, BY_QTY);
    applyUpdates(store, engine, [{ orderId: 'T0000001', orderQty: 50 }]);
    const t0 = Date.now() + 10_000;
    const view = engine.takeRebuild(t0);
    engine.rebuildView(view!, t0);
    applyUpdates(store, engine, [{ orderId: 'T0000002', orderQty: 60 }]);
    expect(engine.takeRebuild(t0 + 500)).toBeNull();
    expect(engine.takeRebuild(t0 + 1_000)).toBe(view);
  });

  it('skip patching while pending, and a pending view that loses its clients is dropped to stale', () => {
    const { store, engine } = setup({ structuralRebuildThreshold: 0 });
    subscribe(engine, BY_QTY);
    applyUpdates(store, engine, [{ orderId: 'T0000001', orderQty: 50 }]);
    const view = [...engine.views()][0];
    const out = applyUpdates(store, engine, [{ orderId: 'T0000002', orderQty: 60 }]);
    expect(out.changes).toHaveLength(0);
    view!.refs--;
    expect(engine.takeRebuild(Date.now() + 10_000)).toBeNull();
    expect(view?.stale).toBe(true);
    expect(view?.rebuildPending).toBe(false);
  });

  it('can be switched off, which rebuilds inside the tick as before', () => {
    const { store, engine } = setup({ structuralRebuildThreshold: 0, deferRebuilds: false });
    subscribe(engine, BY_QTY);
    const out = applyUpdates(store, engine, [{ orderId: 'T0000001', orderQty: 50 }]);
    expect(out.changes[0]?.rebuilt).toBe(true);
    expect([...engine.views()][0]?.rebuildPending).toBe(false);
  });
});

describe('flush budget', () => {
  it('defers views past the budget, carries their changes, and patches them in with the next tick', () => {
    const { store, engine } = setup();
    subscribe(engine, BY_QTY);
    const view = [...engine.views()][0];
    const cs1 = new ChangeSet();
    const r1 = store.updateRow(store.rowIndexOf('T0000001') as number, { orderQty: 50 });
    cs1.noteUpdate(store.rowIndexOf('T0000001') as number, r1.changed, r1.prev);
    expect(engine.applyChanges(cs1, 0)).toHaveLength(0);
    expect(engine.stats().lastApply.deferred).toBe(1);
    expect(view?.hasCarry).toBe(true);
    expect(engine.hasDeferredWork()).toBe(true);
    expect(ids(engine, BY_QTY)).toEqual(['T0000001', 'T0000002', 'T0000003']);

    const cs2 = new ChangeSet();
    const row = store.rowIndexOf('T0000001') as number;
    const r2 = store.updateRow(row, { orderQty: 1 });
    cs2.noteUpdate(row, r2.changed, r2.prev);
    const r3 = store.updateRow(store.rowIndexOf('T0000002') as number, { orderQty: 0 });
    cs2.noteUpdate(store.rowIndexOf('T0000002') as number, r3.changed, r3.prev);
    expect(engine.applyChanges(cs2)).toHaveLength(1);
    expect(view?.hasCarry).toBe(false);
    expect(engine.hasDeferredWork()).toBe(false);
    expect(qty(engine, BY_QTY)).toEqual([0, 1, 3]);
  });

  it('runs a flush with no new changes just to patch in carried ones', () => {
    const { store, engine } = setup();
    subscribe(engine, BY_QTY);
    const cs = new ChangeSet();
    const row = store.rowIndexOf('T0000003') as number;
    const r = store.updateRow(row, { orderQty: 0 });
    cs.noteUpdate(row, r.changed, r.prev);
    engine.applyChanges(cs, 0);
    const changes = engine.applyChanges(new ChangeSet());
    expect(changes).toHaveLength(1);
    expect(qty(engine, BY_QTY)).toEqual([0, 1, 2]);
  });

  it('patches the views with the most clients first, and a view skipped for several ticks goes ahead', () => {
    const { store, engine } = setup();
    subscribe(engine, BY_QTY);
    subscribe(engine, req());
    subscribe(engine, req());
    subscribe(engine, req());
    const views = [...engine.views()];
    const [qtyView, createdView] = views;
    expect(createdView?.refs).toBe(3);
    const tickCs = (n: number): ChangeSet => {
      const cs = new ChangeSet();
      const row = store.rowIndexOf('T0000001') as number;
      const r = store.updateRow(row, { orderQty: n });
      cs.noteUpdate(row, r.changed, r.prev);
      return cs;
    };
    // The first view in line uses the whole budget (a budget of 0 allows none, so use a view-sized one).
    qtyView!.deferredTicks = 3;
    const order: string[] = [];
    const orig = (v: typeof qtyView): void => {
      const f = v!.applyChanges.bind(v);
      v!.applyChanges = (cs, g) => {
        order.push(v === qtyView ? 'qty' : 'created');
        return f(cs, g);
      };
    };
    orig(qtyView);
    orig(createdView);
    engine.applyChanges(tickCs(70));
    expect(order).toEqual(['qty', 'created']);
  });

  it('turns a carry that has grown far past the threshold into a pending rebuild', () => {
    const { store, engine } = setup({ structuralRebuildThreshold: 0 });
    subscribe(engine, BY_QTY);
    const view = [...engine.views()][0];
    const cs = new ChangeSet();
    for (let i = 0; i < 3; i++) {
      const row = i;
      const r = store.updateRow(row, { orderQty: 100 + i });
      cs.noteUpdate(row, r.changed, r.prev);
    }
    engine.applyChanges(cs, 0);
    expect(view?.rebuildPending).toBe(true);
    expect(view?.hasCarry).toBe(false);
  });
});
