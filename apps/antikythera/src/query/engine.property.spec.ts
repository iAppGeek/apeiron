import { mulberry32, type Order, type Rng, type Row, type SsrmRequest } from '@apeiron/logos';
import { describe, expect, it } from 'vitest';
import { propertyOrders, storeFrom } from '../testing/dataset.js';
import { randomRequest } from '../testing/request-gen.js';
import { referenceGetRows } from '../testing/reference.js';
import { QueryEngine } from './engine.js';

const ROWS = 3_000;
const ITERATIONS = 350;

function pickGroupKeys(rng: Rng, orders: readonly Order[], traderId: string, req: SsrmRequest): string[] {
  const keys: string[] = [];
  const depth = Math.floor(rng() * (req.rowGroupCols.length + 1));
  for (let d = 0; d < depth; d++) {
    const level = referenceGetRows(orders, traderId, { ...req, groupKeys: keys, startRow: 0, endRow: ROWS });
    if (level.rows.length === 0 || rng() < 0.03) {
      keys.push('no-such-group');
      break;
    }
    const field = (req.rowGroupCols[d] as { field?: string; id: string }).field ?? '';
    keys.push(String((level.rows[Math.floor(rng() * level.rows.length)] as Row)[field]));
  }
  return keys;
}

function runProperty(datasetSeed: number, requestSeed: number, maxViews: number): void {
  const orders = propertyOrders(datasetSeed, ROWS);
  const store = storeFrom(orders);
  // Small caps force evictions, so warm and cold paths are both exercised.
  const engine = new QueryEngine(store, { maxViews, maxBytes: 200_000, maxBlockRows: ROWS });
  const rng = mulberry32(requestSeed);

  for (let i = 0; i < ITERATIONS; i++) {
    const { traderId, req: base } = randomRequest(rng, orders);
    const groupKeys = pickGroupKeys(rng, orders, traderId, base);
    const full: SsrmRequest = { ...base, groupKeys, startRow: 0, endRow: ROWS };
    const label = `iteration ${i}: ${JSON.stringify({ traderId, ...full })}`;

    const expected = referenceGetRows(orders, traderId, full);
    const actual = engine.getRows(traderId, full);
    if (!actual.ok) throw new Error(`${label} -> ${actual.code}: ${actual.message}`);
    expect(actual.value.rowCount, label).toBe(expected.rowCount);
    expect(actual.value.rows.length, label).toBe(expected.rows.length);
    if (i % 5 === 0) expect(actual.value.rows, label).toEqual(expected.rows);
    else {
      expect(actual.value.rows.slice(0, 60), label).toEqual(expected.rows.slice(0, 60));
      expect(actual.value.rows.slice(-60), label).toEqual(expected.rows.slice(-60));
    }

    // A random block of the same (now cached) view must match as well.
    const start = Math.floor(rng() * (expected.rowCount + 1));
    const end = start + Math.floor(rng() * 150);
    const block: SsrmRequest = { ...full, startRow: start, endRow: end };
    const warm = engine.getRows(traderId, block);
    if (!warm.ok) throw new Error(`${label} block ${start}-${end} -> ${warm.code}`);
    const expectedBlock = referenceGetRows(orders, traderId, block);
    expect(warm.value.rowCount, label).toBe(expectedBlock.rowCount);
    expect(warm.value.rows, `${label} block ${start}-${end}`).toEqual(expectedBlock.rows);
  }
}

describe('engine vs naive reference (property tests)', () => {
  it('matches on dataset seed 1 with a tiny view cache', () => {
    runProperty(1, 101, 3);
  }, 120_000);

  it('matches on dataset seed 2 with a roomy view cache', () => {
    runProperty(2, 202, 64);
  }, 120_000);

  it('matches on dataset seed 3, where ids are not ascending in row order', () => {
    const orders = propertyOrders(3, 1_500);
    const shuffled = [...orders].sort((a, b) => (a.traderId + a.venue + a.orderId < b.traderId + b.venue + b.orderId ? -1 : 1));
    const store = storeFrom(shuffled);
    expect(store.idsAscending).toBe(false);
    const engine = new QueryEngine(store, { maxViews: 8, maxBytes: 1 << 20, maxBlockRows: 5_000 });
    const rng = mulberry32(303);
    for (let i = 0; i < 150; i++) {
      const { traderId, req } = randomRequest(rng, shuffled);
      const full: SsrmRequest = { ...req, groupKeys: pickGroupKeys(rng, shuffled, traderId, req), startRow: 0, endRow: 1_500 };
      const label = `iteration ${i}: ${JSON.stringify({ traderId, ...full })}`;
      const expected = referenceGetRows(shuffled, traderId, full);
      const actual = engine.getRows(traderId, full);
      if (!actual.ok) throw new Error(`${label} -> ${actual.code}`);
      expect(actual.value.rowCount, label).toBe(expected.rowCount);
      expect(actual.value.rows, label).toEqual(expected.rows);
    }
  }, 120_000);
});
