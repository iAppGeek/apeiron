import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installSamplerInPage, readSamplerInPage } from './sampler';

type Row = { data: Record<string, unknown> };
const row = (orderId: string, over: Record<string, unknown> = {}): Row => ({
  data: { orderId, filledQty: 0, numFills: 0, lastUpdateTime: 1000, status: 'LIVE', ...over },
});

describe('invariant sampler', () => {
  let rows: Row[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    rows = [];
    (globalThis as { __apeironTest?: unknown }).__apeironTest = { loadedRows: () => rows };
  });
  afterEach(() => {
    readSamplerInPage();
    delete (globalThis as { __apeironTest?: unknown }).__apeironTest;
    vi.useRealTimers();
  });

  const sample = (next: Row[]): void => {
    rows = next;
    vi.advanceTimersByTime(500);
  };

  it('accepts values that only move forward', () => {
    installSamplerInPage(500);
    sample([row('A')]);
    sample([row('A', { filledQty: 10, numFills: 1, lastUpdateTime: 1500 })]);
    sample([row('A', { filledQty: 10, numFills: 1, lastUpdateTime: 1500, status: 'FILLED' })]);
    const report = readSamplerInPage();
    expect(report).toMatchObject({ samples: 3, ordersSeen: 1, violationCount: 0 });
  });

  it('flags each field that goes backwards', () => {
    installSamplerInPage(500);
    sample([row('A', { filledQty: 10, numFills: 2, lastUpdateTime: 2000 })]);
    sample([row('A', { filledQty: 5, numFills: 1, lastUpdateTime: 1900 })]);
    const report = readSamplerInPage();
    expect(report.violations.map((v) => v.kind).sort()).toEqual(['filledQty', 'lastUpdateTime', 'numFills']);
    expect(report.violations[0]).toMatchObject({ orderId: 'A' });
  });

  it('flags a terminal order that shows as LIVE again, but not PAUSED to LIVE', () => {
    installSamplerInPage(500);
    sample([row('A', { status: 'PAUSED' }), row('B', { status: 'CANCELLED' })]);
    sample([row('A', { status: 'LIVE' }), row('B', { status: 'LIVE' })]);
    const report = readSamplerInPage();
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toMatchObject({ orderId: 'B', kind: 'terminal-regression' });
  });

  it('remembers an order after it leaves the loaded rows', () => {
    installSamplerInPage(500);
    sample([row('A', { filledQty: 10 })]);
    sample([]);
    sample([row('A', { filledQty: 4 })]);
    expect(readSamplerInPage().violationCount).toBe(1);
  });

  it('is idempotent, caps the violation list, and reports nothing after it is read', () => {
    installSamplerInPage(500);
    installSamplerInPage(500);
    sample(Array.from({ length: 100 }, (_, i) => row(`O${i}`, { filledQty: 10 })));
    sample(Array.from({ length: 100 }, (_, i) => row(`O${i}`, { filledQty: 1 })));
    const report = readSamplerInPage();
    expect(report.samples).toBe(2);
    expect(report.violationCount).toBe(100);
    expect(report.violations).toHaveLength(50);
    expect(readSamplerInPage().samples).toBe(0);
  });

  it('records the slowest gap between samples', () => {
    installSamplerInPage(500);
    sample([row('A')]);
    vi.setSystemTime(Date.now() + 3000);
    sample([row('A')]);
    expect(readSamplerInPage().maxGapMs).toBeGreaterThanOrEqual(3000);
  });
});
