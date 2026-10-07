import type { Row, SsrmRequest } from '@apeiron/logos';
import { contiguousRuns, describeDiffs, diffRecords } from './compare';
import type { Driver } from './driver';
import type { SamplerReport } from './sampler';
import type { Reader } from './ws-client';

export type Check = {
  name: string;
  ok: boolean;
  /** The first failures, capped. */
  failures: string[];
  stats: Record<string, number | string>;
};

const MAX_FAILURES = 20;
/** The server's `MAX_BLOCK_ROWS`: the most rows one request may ask for. */
const BLOCK = 5000;
/** Group aggregates are sums over thousands of rows; the incremental and full computations may differ in the last bits. */
const AGGREGATE_TOLERANCE = 1e-9;

class Failures {
  readonly list: string[] = [];
  count = 0;
  add(message: string): void {
    this.count += 1;
    if (this.list.length < MAX_FAILURES) this.list.push(message);
  }
}

const finish = (name: string, failures: Failures, stats: Record<string, number | string>): Check => ({
  name,
  ok: failures.count === 0,
  failures: failures.count > MAX_FAILURES ? [...failures.list, `... and ${failures.count - MAX_FAILURES} more`] : failures.list,
  stats: { ...stats, failures: failures.count },
});

/** Runs `worker` over `items` with at most `limit` in flight. */
export async function pool<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      const item = items[index];
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

// ---------------------------------------------------------------------------------------------------------------
// Check 1: the model against the server

export type ModelCheckInput = {
  driver: Driver;
  reader: Reader;
  /** Orders in the database before the stream started. */
  baselineRowCount: number;
  concurrency?: number;
};

const orderIdSort = [{ colId: 'orderId', sort: 'desc' as const }];
const flat = (over: Partial<SsrmRequest>): SsrmRequest => ({
  startRow: 0,
  endRow: 1,
  rowGroupCols: [],
  valueCols: [],
  groupKeys: [],
  sortModel: orderIdSort,
  ...over,
});

/**
 * Reads back every order the stream created and every order an event touched or a tick repriced, and compares each
 * with the model field for field. Excluded fields are the model's own (`Expected.excluded`): the server clock's
 * `lastUpdateTime` everywhere, and the quote-derived fields of closed orders (see `OrderModel.expected`).
 */
export async function checkModelVsServer(input: ModelCheckInput): Promise<Check> {
  const { driver, reader } = input;
  const model = driver.model();
  const failures = new Failures();
  const created = model.createdIds;
  const createdSet = new Set(created);
  let compared = 0;

  const compare = (serverRow: Row, orderId: string): void => {
    const expected = model.expected(orderId);
    if (expected === undefined) {
      failures.add(`${orderId}: the server holds an order the model has never seen`);
      return;
    }
    const diffs = diffRecords(serverRow, expected.order as unknown as Record<string, unknown>, { excluded: expected.excluded });
    compared += 1;
    if (diffs.length > 0) failures.add(describeDiffs(orderId, diffs));
  };

  // The new orders are the top of the table by id: read them as one run.
  const seen = new Set<string>();
  for (let start = 0; start < created.length + 1; start += BLOCK) {
    const end = Math.min(start + BLOCK, created.length + 1);
    const { rows } = await reader.getRows(flat({ startRow: start, endRow: end }));
    for (const [offset, row] of rows.entries()) {
      const orderId = String(row['orderId']);
      if (start + offset >= created.length) {
        const startMax = driver.startMaxOrderId();
        if (startMax !== null && orderId !== startMax) failures.add(`index ${start + offset}: expected the pre-existing top order ${startMax}, got ${orderId}`);
        continue;
      }
      seen.add(orderId);
      compare(row, orderId);
    }
  }
  for (const id of created) if (!seen.has(id)) failures.add(`${id}: a created order is missing from the server`);

  const rootCount = (await reader.getRows(flat({}))).rowCount;
  const expectedCount = input.baselineRowCount + created.length;
  if (rootCount !== expectedCount) failures.add(`row count: expected ${expectedCount} (${input.baselineRowCount} + ${created.length} created), the server has ${rootCount}`);

  // Everything else the stream touched, one order at a time.
  const others = model.idsToVerify().filter((id) => !createdSet.has(id));
  await pool(others, input.concurrency ?? 8, async (orderId) => {
    const { rows } = await reader.getRows(
      flat({ filterModel: { orderId: { filterType: 'text', type: 'equals', filter: orderId } } }),
    );
    const row = rows[0];
    if (row === undefined || String(row['orderId']) !== orderId) failures.add(`${orderId}: missing from the server`);
    else compare(row, orderId);
  });

  return finish('model-vs-server', failures, {
    ordersCompared: compared,
    created: created.length,
    touchedExisting: others.length,
    rowCount: rootCount,
    modelEvents: model.events,
    unknownUpdates: model.unknown,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Check 2: the server against the screen

/** The loaded-row view of the test hooks, as plain data. */
export type PageSnapshot = {
  rows: { rowIndex: number | null; childIndex: number | null; id: string | undefined; groupKeys: string[]; data: Row }[];
  groups: { rowIndex: number | null; childIndex: number | null; id: string | undefined; level: number; key: string | null; groupKeys: string[]; data: Row }[];
  rootRowCount: number | null;
  statusBarRowCount: number | null;
  summary: {
    byStatus: Record<string, number>;
    liveNotionalUsd: number;
    totalRows: number;
  } | null;
  view: { trader: string; codec: string; sort: unknown[]; filter: Record<string, unknown>; grouping: string[] };
  request: SsrmRequest | null;
  busy: boolean;
};

const keyString = (route: readonly string[]): string => route.join('\u0000');

/**
 * For one page: every row the grid holds must equal a fresh server read, field for field, at the same position;
 * the root row count, each group's `childCount` and aggregates, and the summary chips must match too.
 */
export async function checkServerVsScreen(name: string, snapshot: PageSnapshot, reader: Reader): Promise<Check> {
  const failures = new Failures();
  const stats: Record<string, number | string> = { loadedRows: snapshot.rows.length, loadedGroups: snapshot.groups.length };
  const template = snapshot.request;
  if (template === null) {
    failures.add('the page has not sent a getRows request');
    return finish(name, failures, stats);
  }
  if (snapshot.busy) failures.add('the page is still switching or loading after the quiet period');
  const read = (route: readonly string[], startRow: number, endRow: number): Promise<{ rows: Row[]; rowCount: number }> =>
    reader.getRows({ ...template, startRow, endRow, groupKeys: [...route] });

  // Root count, status bar and summary.
  const summaryWait = reader.nextSummary();
  const root = await read([], 0, 1);
  stats['serverRootRowCount'] = root.rowCount;
  if (snapshot.rootRowCount !== root.rowCount) failures.add(`root row count: the grid has ${String(snapshot.rootRowCount)}, the server ${root.rowCount}`);
  if (snapshot.statusBarRowCount !== root.rowCount) failures.add(`status bar row count: ${String(snapshot.statusBarRowCount)}, the server ${root.rowCount}`);
  const summary = await summaryWait;
  if (snapshot.summary === null) failures.add('the page has no summary');
  else {
    const diffs = diffRecords(
      { ...snapshot.summary.byStatus, liveNotionalUsd: snapshot.summary.liveNotionalUsd, totalRows: snapshot.summary.totalRows },
      { ...summary.byStatus, liveNotionalUsd: summary.liveNotionalUsd, totalRows: summary.totalRows },
      { tolerance: AGGREGATE_TOLERANCE },
      true,
    );
    if (diffs.length > 0) failures.add(describeDiffs('summary chips', diffs));
  }

  // Leaf rows, route by route.
  const byRoute = new Map<string, PageSnapshot['rows']>();
  for (const row of snapshot.rows) {
    const key = keyString(row.groupKeys);
    byRoute.set(key, [...(byRoute.get(key) ?? []), row]);
  }
  let compared = 0;
  let runsRead = 0;
  for (const rows of byRoute.values()) {
    const route = rows[0]?.groupKeys ?? [];
    const positioned = rows.every((r) => (route.length === 0 ? r.rowIndex : r.childIndex) !== null);
    if (!positioned) {
      await pool(rows, 8, async (row) => {
        const found = await reader.getRows(
          flat({ ...template, startRow: 0, endRow: 1, groupKeys: [...route], filterModel: { ...(template.filterModel ?? {}), orderId: { filterType: 'text', type: 'equals', filter: String(row.data['orderId']) } }, sortModel: orderIdSort }),
        );
        compared += 1;
        const server = found.rows[0];
        if (server === undefined) failures.add(`${String(row.data['orderId'])}: on screen but not on the server`);
        else {
          const diffs = diffRecords(row.data, server, {}, true);
          if (diffs.length > 0) failures.add(describeDiffs(String(row.data['orderId']), diffs));
        }
      });
      continue;
    }
    const indexOf = (r: PageSnapshot['rows'][number]): number => (route.length === 0 ? r.rowIndex : r.childIndex) as number;
    const sorted = [...rows].sort((a, b) => indexOf(a) - indexOf(b));
    for (const run of contiguousRuns(sorted.map(indexOf))) {
      for (let start = run.start; start < run.end; start += BLOCK) {
        const end = Math.min(start + BLOCK, run.end);
        const fetched = await read(route, start, end);
        runsRead += 1;
        for (let index = start; index < end; index += 1) {
          const screen = sorted.find((r) => indexOf(r) === index);
          const server = fetched.rows[index - start];
          if (screen === undefined) continue;
          compared += 1;
          if (server === undefined) {
            failures.add(`row ${index}: on screen (${String(screen.data['orderId'])}) but the server has no row there`);
            continue;
          }
          if (String(server['orderId']) !== String(screen.data['orderId'])) {
            failures.add(`row ${index}: the screen shows ${String(screen.data['orderId'])}, the server has ${String(server['orderId'])} there`);
            continue;
          }
          const diffs = diffRecords(screen.data, server, {}, true);
          if (diffs.length > 0) failures.add(describeDiffs(`row ${index} ${String(server['orderId'])}`, diffs));
        }
      }
    }
  }
  stats['leafRowsCompared'] = compared;
  stats['runsRead'] = runsRead;

  // Group rows: childCount and aggregates, matched by key within their parent route.
  const byParent = new Map<string, PageSnapshot['groups']>();
  for (const group of snapshot.groups) {
    const key = keyString(group.groupKeys);
    byParent.set(key, [...(byParent.get(key) ?? []), group]);
  }
  let groupsCompared = 0;
  for (const groups of byParent.values()) {
    const parentRoute = groups[0]?.groupKeys ?? [];
    const level = groups[0]?.level ?? 0;
    const column = template.rowGroupCols[level];
    const field = column?.field ?? column?.id;
    if (field === undefined) {
      failures.add(`group level ${level} has no group column in the request`);
      continue;
    }
    const fetched = await read(parentRoute, 0, BLOCK);
    const serverByKey = new Map(fetched.rows.map((row) => [String(row[field]), row]));
    for (const group of groups) {
      const server = serverByKey.get(String(group.key));
      groupsCompared += 1;
      if (server === undefined) {
        failures.add(`group ${String(group.key)}: on screen but not on the server`);
        continue;
      }
      const diffs = diffRecords(group.data, server, { tolerance: AGGREGATE_TOLERANCE });
      if (diffs.length > 0) failures.add(describeDiffs(`group ${[...parentRoute, String(group.key)].join('/')}`, diffs));
    }
  }
  stats['groupsCompared'] = groupsCompared;

  return finish(name, failures, stats);
}

// ---------------------------------------------------------------------------------------------------------------
// Check 3: invariants during the run, and the minimums

export function checkInvariants(name: string, report: SamplerReport): Check {
  const failures = new Failures();
  if (report.samples === 0) failures.add('the sampler took no samples');
  for (const v of report.violations) failures.add(`${v.orderId}: ${v.kind} went from ${String(v.previous)} to ${String(v.current)} at ${v.atMs}ms`);
  if (report.violationCount > report.violations.length) failures.add(`and ${report.violationCount - report.violations.length} more violations`);
  return finish(name, failures, {
    samples: report.samples,
    ordersSeen: report.ordersSeen,
    violations: report.violationCount,
    maxSampleGapMs: report.maxGapMs,
  });
}

export type Minimums = { reconnects: number; deltas: number };

/** A scenario fails unless every page saw at least the expected reconnects and deltas, so it cannot pass by doing nothing. */
export function checkMinimums(name: string, seen: { reconnects: number; deltas: number }, minimums: Minimums): Check {
  const failures = new Failures();
  if (seen.reconnects < minimums.reconnects) failures.add(`reconnects: saw ${seen.reconnects}, need at least ${minimums.reconnects}`);
  if (seen.deltas < minimums.deltas) failures.add(`deltas applied: saw ${seen.deltas}, need at least ${minimums.deltas}`);
  return finish(name, failures, { reconnects: seen.reconnects, deltas: seen.deltas, minReconnects: minimums.reconnects, minDeltas: minimums.deltas });
}

