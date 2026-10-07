import { COLUMNS, GROUPABLE_FIELDS, type ColumnMeta } from '@apeiron/logos';
import type { ColDef, ValueFormatterParams } from 'ag-grid-community';
import { describe, expect, it, vi } from 'vitest';
import { StatusChip, sideCellClass } from './cell-renderers';
import {
  ALLOWED_AGG_FUNCS,
  STATUS_MIN_WIDTH,
  buildColumnDef,
  buildColumnDefs,
  headerMinWidth,
  toWireAggFunc,
} from './column-defs';

const makeDeps = (values: string[] = ['A', 'B']): { fetchFilterValues: ReturnType<typeof vi.fn<(c: string) => Promise<string[]>>> } => ({
  fetchFilterValues: vi.fn<(colId: string) => Promise<string[]>>().mockResolvedValue(values),
});

const defs = buildColumnDefs(COLUMNS, makeDeps());
const byId = (id: string): ColDef => {
  const d = defs.find((x) => x.colId === id);
  if (d === undefined) throw new Error(`no def ${id}`);
  return d;
};
const format = (def: ColDef, value: unknown, data: unknown): string => {
  const f = def.valueFormatter;
  if (typeof f !== 'function') throw new Error('no formatter');
  return f({ value, data } as unknown as ValueFormatterParams) as string;
};

describe('buildColumnDefs', () => {
  it('builds one definition per column, in metadata order', () => {
    expect(defs).toHaveLength(50);
    expect(defs.map((d) => d.colId)).toEqual(COLUMNS.map((c) => c.field));
    expect(defs.map((d) => d.field)).toEqual(COLUMNS.map((c) => c.field));
  });

  it('takes headerName and width from the metadata, never narrower than the header needs', () => {
    expect(byId('orderQty').headerName).toBe('Order Qty');
    expect(byId('orderQty').width).toBe(130);
    for (const meta of COLUMNS) {
      const def = byId(meta.field);
      expect(def.minWidth).toBe(headerMinWidth(def.headerName ?? ''));
      expect(def.width).toBeGreaterThanOrEqual(def.minWidth ?? 0);
      expect(def.width).toBeGreaterThanOrEqual(meta.width ?? 0);
      expect(def.headerTooltip).toBe(def.headerName);
    }
  });

  it('labels datetime columns as UTC and leaves the rest alone', () => {
    expect(byId('createdAt').headerName).toBe('Created (UTC)');
    expect(byId('lastUpdateTime').headerName).toBe('Last Update (UTC)');
    expect(byId('completedAt').headerName).toBe('Completed (UTC)');
    expect(byId('valueDate').headerName).toBe('Value Date');
    expect(byId('side').headerName).toBe('Side');
  });

  it('pins Order ID to the left and nothing else', () => {
    expect(byId('orderId').pinned).toBe('left');
    expect(defs.filter((d) => d.pinned !== undefined)).toHaveLength(1);
  });

  it('gives short headers enough room for the full label (Trader ID, Base, Quote, Tenor, Side)', () => {
    for (const id of ['traderId', 'baseCcy', 'quoteCcy', 'tenor', 'side']) {
      const def = byId(id);
      expect(def.width).toBeGreaterThanOrEqual(headerMinWidth(def.headerName ?? ''));
    }
    expect(headerMinWidth('Trader ID')).toBe(127);
  });

  it('widens the status column for the chip', () => {
    expect(byId('status').width).toBe(STATUS_MIN_WIDTH);
    expect(byId('status').cellRenderer).toBe(StatusChip);
  });

  it('maps every filter kind to the matching AG Grid filter', () => {
    const expected = { text: 'agTextColumnFilter', set: 'agSetColumnFilter', number: 'agNumberColumnFilter', date: 'agDateColumnFilter' };
    for (const meta of COLUMNS) {
      expect(byId(meta.field).filter).toBe(expected[meta.filter]);
    }
  });

  it('sets inRangeInclusive on number and date filters', () => {
    for (const meta of COLUMNS.filter((c) => c.filter === 'number' || c.filter === 'date')) {
      expect(byId(meta.field).filterParams).toMatchObject({ inRangeInclusive: true });
    }
    expect(byId('valueDate').filterParams).toMatchObject({ inRangeInclusive: true });
  });

  it('enables row grouping exactly on the groupable columns', () => {
    const grouped = defs.filter((d) => d.enableRowGroup === true).map((d) => d.colId);
    expect(grouped.sort()).toEqual([...GROUPABLE_FIELDS].sort());
  });

  it('sets the default sort to createdAt desc and nothing else', () => {
    expect(byId('createdAt').sort).toBe('desc');
    expect(defs.filter((d) => d.sort !== undefined)).toHaveLength(1);
  });

  it('right-aligns numeric columns', () => {
    expect(byId('orderQty').type).toBe('numericColumn');
    expect(byId('limitPrice').type).toBe('numericColumn');
    expect(byId('status').type).toBeUndefined();
  });

  it('colours the side column', () => {
    expect(byId('side').cellClass).toBe(sideCellClass);
  });
});

describe('aggregates', () => {
  it('maps aggFunc from the metadata and wavg:notionalUsd to the wire name wavg', () => {
    expect(byId('notionalUsd').aggFunc).toBe('sum');
    expect(byId('slippageBps').aggFunc).toBe('wavg');
    expect(byId('pctComplete').aggFunc).toBe('wavg');
    expect(byId('perfVsVwapBps').aggFunc).toBe('wavg');
    expect(toWireAggFunc('wavg:notionalUsd')).toBe('wavg');
    expect(toWireAggFunc('avg')).toBe('avg');
    expect(toWireAggFunc('count')).toBe('count');
  });

  it('sets aggFunc only where the metadata has one, restricted to server-supported names', () => {
    for (const meta of COLUMNS) {
      const def = byId(meta.field);
      if (meta.aggFunc === undefined) {
        expect(def.aggFunc).toBeUndefined();
        expect(def.enableValue).toBeUndefined();
      } else {
        expect(def.enableValue).toBe(true);
        expect(def.allowedAggFuncs).toEqual([...ALLOWED_AGG_FUNCS]);
      }
    }
  });
});

describe('set filter values', () => {
  it('fetches the values through setFilterValues and hands them to the filter', async () => {
    const deps = makeDeps(['LIVE', 'FILLED']);
    const def = buildColumnDef(COLUMNS.find((c) => c.field === 'status') as ColumnMeta, deps);
    const params = (def.filterParams as { values: (p: { success: (v: string[]) => void }) => void });
    const success = vi.fn();
    params.values({ success });
    await vi.waitFor(() => {
      expect(success).toHaveBeenCalledWith(['LIVE', 'FILLED']);
    });
    expect(deps.fetchFilterValues).toHaveBeenCalledWith('status');
    expect(def.filterParams).toMatchObject({ refreshValuesOnOpen: true });
  });

  it('gives the filter an empty list when the fetch fails', async () => {
    const deps = { fetchFilterValues: vi.fn<(c: string) => Promise<string[]>>().mockRejectedValue(new Error('x')) };
    const def = buildColumnDef(COLUMNS.find((c) => c.field === 'venue') as ColumnMeta, deps);
    const success = vi.fn();
    (def.filterParams as { values: (p: { success: (v: string[]) => void }) => void }).values({ success });
    await vi.waitFor(() => {
      expect(success).toHaveBeenCalledWith([]);
    });
  });
});

describe('value formatters', () => {
  it('uses pair decimals for price columns and the 5-decimal fallback on group rows', () => {
    expect(format(byId('limitPrice'), 150.123456, { currencyPair: 'USDJPY' })).toBe('150.123');
    expect(format(byId('limitPrice'), 1.5, { childCount: 4 })).toBe('1.50000');
  });

  it('formats nulls as empty, numbers with separators, and dates', () => {
    expect(format(byId('limitPrice'), null, { currencyPair: 'EURUSD' })).toBe('');
    expect(format(byId('orderQty'), 2500000, {})).toBe('2,500,000');
    expect(format(byId('valueDate'), Date.UTC(2026, 1, 2), {})).toBe('2026-02-02');
  });

  describe('price tick colouring', () => {
    type RuleParams = { node: { id?: string } };
    const rules = (def: ColDef): Record<string, (p: RuleParams) => boolean> =>
      def.cellClassRules as unknown as Record<string, (p: RuleParams) => boolean>;

    it('adds no class rules without a tick source, and none to non-price columns', () => {
      expect(byId('marketMid').cellClassRules).toBeUndefined();
      const withTicks = buildColumnDefs(COLUMNS, { ...makeDeps(), tickDirection: () => 'up' });
      expect(withTicks.find((d) => d.colId === 'orderQty')?.cellClassRules).toBeUndefined();
    });

    it('adds tick-up and tick-down rules to every price column, driven by the tracked direction', () => {
      const tickDirection = vi.fn<(rowId: string | undefined, field: string) => 'up' | 'down' | null>().mockReturnValue('up');
      const withTicks = buildColumnDefs(COLUMNS, { ...makeDeps(), tickDirection });
      const priceFields = COLUMNS.filter((c) => c.priceColumn === true).map((c) => c.field);
      expect(priceFields.length).toBeGreaterThan(0);
      for (const field of priceFields) {
        const def = withTicks.find((d) => d.colId === field) as ColDef;
        expect(Object.keys(rules(def))).toEqual(['tick-up', 'tick-down']);
      }
      const mid = withTicks.find((d) => d.colId === 'marketMid') as ColDef;
      expect(rules(mid)['tick-up']?.({ node: { id: 'A' } })).toBe(true);
      expect(rules(mid)['tick-down']?.({ node: { id: 'A' } })).toBe(false);
      expect(tickDirection).toHaveBeenCalledWith('A', 'marketMid');
      tickDirection.mockReturnValue('down');
      expect(rules(mid)['tick-up']?.({ node: { id: 'A' } })).toBe(false);
      expect(rules(mid)['tick-down']?.({ node: { id: 'A' } })).toBe(true);
      tickDirection.mockReturnValue(null);
      expect(rules(mid)['tick-up']?.({ node: {} })).toBe(false);
      expect(rules(mid)['tick-down']?.({ node: {} })).toBe(false);
    });
  });
});
