import { parseClientMsg, parseFilterModel, mulberry32 } from '@apeiron/logos';
import { describe, expect, it } from 'vitest';
import { BLOCK_SIZE, ViewKnowledge, changeView, clientRng, pickScrollTarget, planClients, randomView, requestFor, type ViewSpec } from './scenario.js';

const NOW = Date.UTC(2026, 9, 7);

describe('planClients', () => {
  const plan = (over: Partial<Parameters<typeof planClients>[0]> = {}): ReturnType<typeof planClients> =>
    planClients({ clients: 50, codec: 'json', seed: 1, special: true, nowMs: NOW, ...over });

  it('is deterministic per seed and differs between seeds', () => {
    expect(plan()).toEqual(plan());
    expect(plan({ seed: 2 })).not.toEqual(plan());
  });

  it('makes one slow consumer, one codec switcher and one controller among the clients', () => {
    const p = plan();
    expect(p).toHaveLength(50);
    expect(p.filter((c) => c.role === 'slow')).toHaveLength(1);
    expect(p.filter((c) => c.role === 'switcher')).toHaveLength(1);
    expect(p.filter((c) => c.controller)).toHaveLength(1);
    expect(p.find((c) => c.controller)?.role).toBe('normal');
    expect(new Set(p.map((c) => c.clientId)).size).toBe(50);
  });

  it('has no special roles when switched off or with fewer than four clients', () => {
    expect(plan({ special: false }).every((c) => c.role === 'normal' && !c.controller)).toBe(true);
    expect(plan({ clients: 3 }).every((c) => c.role === 'normal')).toBe(true);
  });

  it('alternates codecs for both, otherwise uses the chosen one', () => {
    expect(plan({ codec: 'both' }).map((c) => c.codec).slice(0, 4)).toEqual(['json', 'msgpack', 'json', 'msgpack']);
    expect(plan({ codec: 'msgpack' }).every((c) => c.codec === 'msgpack')).toBe(true);
  });

  it('mixes ALL and T1 to T5 across a population', () => {
    const traders = new Set(plan().map((c) => c.traderId));
    expect(traders.has('ALL')).toBe(true);
    for (const t of traders) expect(['ALL', 'T1', 'T2', 'T3', 'T4', 'T5']).toContain(t);
    expect(traders.size).toBeGreaterThan(3);
  });
});

describe('views and requests', () => {
  const views = Array.from({ length: 300 }, (_, i) => randomView(clientRng(3, i), NOW));

  it('produces requests the server accepts: valid client messages with parseable filter models', () => {
    for (const view of views) {
      const req = requestFor(view, 200, []);
      expect(parseClientMsg({ t: 'getRows', reqId: 1, req }).ok).toBe(true);
      if (req.filterModel !== null && req.filterModel !== undefined) expect(parseFilterModel(req.filterModel).ok).toBe(true);
    }
  });

  it('covers flat and grouped views, sorts, and each filter kind', () => {
    expect(views.some((v) => v.rowGroupCols.length === 0)).toBe(true);
    expect(views.some((v) => v.rowGroupCols.length === 2)).toBe(true);
    expect(views.some((v) => v.sortModel.length > 0)).toBe(true);
    const kinds = new Set(views.flatMap((v) => Object.values(v.filterModel ?? {}).map((f) => (f as { filterType: string }).filterType)));
    expect(kinds).toEqual(new Set(['set', 'number', 'date', 'text']));
  });

  it('sorts a grouped view only by columns the grouped response has', () => {
    for (const v of views.filter((x) => x.rowGroupCols.length > 0)) {
      const ids = new Set(['ag-Grid-AutoColumn', ...v.valueCols.map((c) => c.id)]);
      for (const s of v.sortModel) expect(ids.has(s.colId)).toBe(true);
    }
  });

  it('sends a 100-row block with the group keys of the route', () => {
    const req = requestFor(views[0] as ViewSpec, 300, ['EURUSD']);
    expect(req).toMatchObject({ startRow: 300, endRow: 400, groupKeys: ['EURUSD'] });
    expect(requestFor(views[0] as ViewSpec, 0, [], 2000).endRow).toBe(2000);
  });

  it('changeView always gives a different view, and does so for every kind of change', () => {
    const rng = mulberry32(5);
    let view = views[0] as ViewSpec;
    const seen = { sort: 0, filter: 0, group: 0 };
    for (let i = 0; i < 200; i++) {
      const next = changeView(rng, view, NOW);
      expect(JSON.stringify(next)).not.toBe(JSON.stringify(view));
      if (JSON.stringify(next.sortModel) !== JSON.stringify(view.sortModel)) seen.sort++;
      if (JSON.stringify(next.filterModel) !== JSON.stringify(view.filterModel)) seen.filter++;
      if (JSON.stringify(next.rowGroupCols) !== JSON.stringify(view.rowGroupCols)) seen.group++;
      view = next;
    }
    expect(seen.sort).toBeGreaterThan(20);
    expect(seen.filter).toBeGreaterThan(20);
    expect(seen.group).toBeGreaterThan(20);
  });
});

describe('scroll targets', () => {
  const flat: ViewSpec = { rowGroupCols: [], valueCols: [], sortModel: [], filterModel: null };
  const grouped: ViewSpec = { rowGroupCols: [{ id: 'status', field: 'status' }, { id: 'venue', field: 'venue' }], valueCols: [], sortModel: [], filterModel: null };

  it('asks for block 0 until the row count is known, then any block, a quarter of the time the top one', () => {
    const rng = mulberry32(1);
    const k = new ViewKnowledge(flat);
    expect(pickScrollTarget(rng, flat, k)).toEqual({ groupKeys: [], startRow: 0 });
    k.learn([], [], 10_000);
    const starts = Array.from({ length: 1000 }, () => pickScrollTarget(rng, flat, k).startRow);
    expect(starts.every((s) => s % BLOCK_SIZE === 0 && s >= 0 && s < 10_000)).toBe(true);
    expect(starts.filter((s) => s === 0).length / 1000).toBeGreaterThan(0.2);
    expect(Math.max(...starts)).toBeGreaterThan(8_000);
  });

  it('drills into group keys it has actually been sent, down to the leaf level', () => {
    const rng = mulberry32(2);
    const k = new ViewKnowledge(grouped);
    k.learn([], [{ status: 'LIVE', childCount: 5 }, { status: 'FILLED', childCount: 9 }], 2);
    k.learn(['LIVE'], [{ venue: 'EBS', childCount: 2 }], 1);
    const routes = Array.from({ length: 400 }, () => pickScrollTarget(rng, grouped, k).groupKeys);
    expect(routes.some((r) => r.length === 0)).toBe(true);
    expect(routes.some((r) => r.length === 1)).toBe(true);
    expect(routes.some((r) => r.length === 2 && r[0] === 'LIVE' && r[1] === 'EBS')).toBe(true);
    for (const r of routes) expect(r.every((key) => ['LIVE', 'FILLED', 'EBS'].includes(key))).toBe(true);
  });

  it('remembers counts per route and de-duplicates keys', () => {
    const k = new ViewKnowledge(grouped);
    k.learn([], [{ status: 'LIVE' }], 3);
    k.learn([], [{ status: 'LIVE' }, { status: 'PAUSED' }], 3);
    expect(k.groupKeysAt([])).toEqual(['LIVE', 'PAUSED']);
    expect(k.rowCount([])).toBe(3);
    expect(k.rowCount(['LIVE'])).toBeUndefined();
  });
});
