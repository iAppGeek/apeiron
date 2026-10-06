import { COLUMNS, GROUPABLE_FIELDS, type ColumnMeta } from '@apeiron/logos';
import type { ColDef, ValueFormatterParams } from 'ag-grid-community';
import { describe, expect, it, vi } from 'vitest';
import { StatusChip, sideCellClass } from './cell-renderers';
import {
  ALLOWED_AGG_FUNCS,
  STATUS_MIN_WIDTH,
  buildColumnDef,
  buildColumnDefs,
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

  it('takes headerName and width from the metadata', () => {
    expect(byId('orderQty').headerName).toBe('Order Qty');
    expect(byId('orderQty').width).toBe(130);
    expect(byId('createdAt').width).toBe(160);
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
});
