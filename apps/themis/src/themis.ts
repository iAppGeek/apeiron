import {
  BUCKETS,
  CONSUMERS,
  STREAMS,
  SUBJECTS,
  applyExecReport,
  formatOrderId,
  isTerminal,
  parseExecReport,
  parseOrderSeq,
  parseOrderStateRecord,
  recordFromSubmission,
  validateSubmission,
  type Bus,
  type BusSubscription,
  type KvBucket,
  type OrderStateRecord,
  type SubmitReply,
} from '@apeiron/logos';
import type { OrderRepository, StoredOrder } from '@apeiron/mnemosyne';
import { GroupCommitter, toStateRecord } from './committer.js';
import type { Logger } from './log.js';
import type { ThemisMetrics } from './metrics.js';
import { ensureProjection, reconcileProjection } from './projection.js';

export type ThemisOptions = {
  bus: Bus;
  repo: OrderRepository;
  log: Logger;
  groupCommitMs: number;
  groupCommitMax: number;
  reconcileWindowMin: number;
  rebuildProjection: boolean;
  metrics?: ThemisMetrics;
  now?: () => number;
};

export type ThemisStatus = { status: 'ok' | 'stopped'; openOrders: number; applied: number; commits: number };

/** Open orders go to a caller in messages of at most this many records. */
export const QUERY_CHUNK = 500;

/** How long a `clientOrderId` is remembered, so a repeated submission returns the order it made. */
export const SUBMISSION_MEMORY_MS = 24 * 3_600_000;

export type Themis = {
  status(): ThemisStatus;
  debug(): Record<string, unknown>;
  /** Commits everything queued and waits for it. */
  flush(): Promise<void>;
  /** Stops consuming. `flush: false` abandons whatever is not yet committed, as a crash would. */
  stop(options?: { flush?: boolean }): Promise<void>;
};

/** `ORDER_STATE`: one key per order, last value only. */
export const ORDER_STATE_CONFIG = { history: 1, storage: 'file', replicas: 1, maxValueSize: 16 * 1024, maxBytes: 4 * 1024 ** 3 } as const;
export const ORDER_STATE_META_CONFIG = { history: 1, storage: 'file', replicas: 1 } as const;

const isOpenRecord = (stored: StoredOrder): boolean => !isTerminal(stored.order.status);

/**
 * The order service of record. It owns the database: it takes submissions and execution reports from the venue,
 * applies them to the full order with the shared rules, stores each batch (group commit) and only then publishes the new
 * version to the `ORDER_STATE` bucket and acknowledges the input.
 * Startup makes sure the bucket holds every order, reconciles anything a crash left unpublished, and loads the
 * open orders into memory. Events are handled one at a time, so an order's versions are strictly ordered.
 */
export async function startThemis(options: ThemisOptions): Promise<Themis> {
  const { bus, repo, log, metrics } = options;
  const state = bus.kv(BUCKETS.orderState);
  const meta = bus.kv(BUCKETS.orderStateMeta);
  await state.ensure({ history: 1, storage: 'file', replicas: 1, maxValueSize: ORDER_STATE_CONFIG.maxValueSize, maxBytes: ORDER_STATE_CONFIG.maxBytes });
  await meta.ensure({ history: 1, storage: 'file', replicas: 1 });

  const deps = { repo, state, meta, log, ...(options.now === undefined ? {} : { now: options.now }) };
  const rebuilt = await ensureProjection(deps, options.rebuildProjection);
  if (rebuilt !== null) metrics?.projectionRebuilt(rebuilt.seconds);
  else await reconcileProjection(deps, options.reconcileWindowMin * 60_000);

  /** Open orders, plus terminal ones whose last version is still being committed. */
  const book = new Map<string, StoredOrder>();
  for (const stored of await repo.loadOpen()) book.set(stored.order.orderId, stored);
  log.info({ open: book.size }, 'loaded open orders');

  const committer = new GroupCommitter({
    repo,
    state,
    log,
    windowMs: options.groupCommitMs,
    maxBatch: options.groupCommitMax,
    ...(metrics === undefined ? {} : { metrics }),
  });
  let applied = 0;
  let stopped = false;

  const openOrders = (): number => {
    let n = 0;
    for (const stored of book.values()) if (isOpenRecord(stored)) n++;
    return n;
  };
  metrics?.bind(() => ({ openOrders: openOrders() }));

  const lookup = async (orderId: string, kv: KvBucket): Promise<StoredOrder | undefined> => {
    const held = book.get(orderId);
    if (held !== undefined) return held;
    const entry = await kv.get(orderId);
    if (entry === null) return undefined;
    const parsed = parseOrderStateRecord(entry.value);
    return parsed.ok ? { order: parsed.value.order, v: parsed.value.v, execSeq: parsed.value.execSeq } : undefined;
  };

  /** Forgets a finished order only if nothing newer has been applied since, then acknowledges the input. */
  const finish = (record: StoredOrder, ack: () => void) => (): void => {
    if (!isOpenRecord(record) && book.get(record.order.orderId)?.v === record.v) book.delete(record.order.orderId);
    ack();
  };

  // Inputs are applied one at a time, in arrival order, so an order's versions are strictly ordered. Applying does not
  // wait for the commit: the batch window is what makes this fast.
  let chain: Promise<void> = Promise.resolve();
  const enqueue = <T,>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task);
    chain = run.then(
      () => undefined,
      (error: unknown) => {
        log.error({ err: error }, 'failed to handle an input');
      },
    );
    return run;
  };

  const consumers: BusSubscription[] = [];

  // ---- execution: submissions, execution reports from the venue, and the open orders for whoever needs them

  let seq = parseOrderSeq((await repo.maxOrderId()) ?? 'ALG00000000') ?? 0;
  const submitted = new Map<string, { orderId: string; v: number; at: number }>();
  for (const stored of book.values()) {
    if (stored.order.clientOrderId !== '') submitted.set(stored.order.clientOrderId, { orderId: stored.order.orderId, v: stored.v, at: stored.order.createdAt });
  }
  const clock = options.now ?? ((): number => Date.now());

  const submit = (payload: unknown): Promise<SubmitReply> =>
    new Promise<SubmitReply>((resolve) => {
      void enqueue(() => {
        const checked = validateSubmission(payload);
        if (!checked.ok) {
          metrics?.submission('invalid');
          resolve({ ok: false, code: 'INVALID_SUBMISSION', message: checked.message });
          return Promise.resolve();
        }
        const key = checked.submission.clientOrderId;
        const seen = submitted.get(key);
        if (seen !== undefined) {
          metrics?.submission('duplicate');
          committer.whenCommitted(() => resolve({ ok: true, orderId: seen.orderId, v: seen.v }));
          return Promise.resolve();
        }
        const now = clock();
        for (const [id, entry] of submitted) if (now - entry.at > SUBMISSION_MEMORY_MS) submitted.delete(id);
        const orderId = formatOrderId(++seq);
        const record = recordFromSubmission(checked.submission, orderId, now);
        const stored: StoredOrder = { order: record.order, v: record.v, execSeq: record.execSeq };
        book.set(orderId, stored);
        submitted.set(key, { orderId, v: stored.v, at: now });
        metrics?.submission('accepted');
        committer.submit(stored, record.srcTs, () => resolve({ ok: true, orderId, v: stored.v }));
        return Promise.resolve();
      });
    });

  const handleReport = async (payload: unknown, ack: () => void): Promise<void> => {
    const parsed = parseExecReport(payload);
    if (!parsed.ok) {
      log.warn({ error: parsed.error }, 'dropped invalid execution report');
      metrics?.report('invalid', 'invalid');
      committer.whenCommitted(ack);
      return;
    }
    const report = parsed.value;
    const current = await lookup(report.orderId, state);
    if (current === undefined) {
      log.warn({ orderId: report.orderId, type: report.type }, 'execution report for an unknown order');
      metrics?.report(report.type, 'unknown');
      committer.whenCommitted(ack);
      return;
    }
    const held: OrderStateRecord = { v: current.v, execSeq: current.execSeq, srcTs: current.order.lastUpdateTime, order: current.order };
    const result = applyExecReport(held, report);
    if (result.kind === 'duplicate') {
      metrics?.report(report.type, 'duplicate');
      committer.whenCommitted(ack);
      return;
    }
    // An applied report is a new version. A rejected one (or a venue refusal) changes nothing but the counter, which is
    // stored so that a bad report is not replayed for ever.
    const next = result.record;
    const stored: StoredOrder = { order: next.order, v: next.v, execSeq: next.execSeq };
    book.set(stored.order.orderId, stored);
    if (result.kind === 'applied') {
      applied++;
      if (result.clamped) metrics?.clamped();
    } else {
      log.debug({ orderId: report.orderId, type: report.type, kind: result.kind }, 'execution report not applied');
    }
    metrics?.report(report.type, result.kind === 'applied' ? 'applied' : 'rejected');
    committer.submit(stored, report.ts, finish(stored, ack));
  };

  consumers.push(
    await bus.consume({ stream: STREAMS.exec, durable: CONSUMERS.themisExec, subject: SUBJECTS.execReports }, (payload, _subject, ack) => {
      void enqueue(() => handleReport(payload, ack));
    }),
  );
  log.info({ stream: STREAMS.exec, durable: CONSUMERS.themisExec }, 'consuming execution reports');

  consumers.push(await bus.serve(SUBJECTS.ordersSubmit, submit));

  // The open orders, in messages of at most QUERY_CHUNK records published to the caller's inbox, then a summary reply.
  consumers.push(
    await bus.serve(SUBJECTS.ordersQueryOpen, (payload) => {
      const inbox = (payload as { inbox?: unknown } | null)?.inbox;
      if (typeof inbox !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(inbox)) throw new Error('orders.query.open needs an inbox subject');
      return enqueue(async () => {
        const records = [...book.values()].filter(isOpenRecord).map((stored) => toStateRecord(stored, stored.order.lastUpdateTime));
        const chunks = Math.max(1, Math.ceil(records.length / QUERY_CHUNK));
        for (let i = 0; i < chunks; i++) {
          await bus.publish(inbox, { chunk: i, of: chunks, records: records.slice(i * QUERY_CHUNK, (i + 1) * QUERY_CHUNK) });
        }
        return { chunks, count: records.length };
      });
    }),
  );

  // The price feed asks for a starting level per pair when its stream has no last price (it never reads orders).
  consumers.push(await bus.serve(SUBJECTS.refMids, () => repo.latestMidsByPair()));

  return {
    status: (): ThemisStatus => ({ status: stopped ? 'stopped' : 'ok', openOrders: openOrders(), applied, commits: committer.stats.batches }),
    debug: (): Record<string, unknown> => ({
      openOrders: openOrders(),
      heldOrders: book.size,
      pendingInstructions: 0,
      queued: committer.pending,
      lastCommit: { size: committer.stats.lastSize, ms: committer.stats.lastMs, kvMs: committer.stats.lastKvMs },
      commits: committer.stats.batches,
    }),
    flush: async (): Promise<void> => {
      await chain;
      await committer.flush();
    },
    stop: async (stopOptions: { flush?: boolean } = {}): Promise<void> => {
      stopped = true;
      for (const sub of consumers) await sub.close();
      if (stopOptions.flush === false) return;
      await chain;
      await committer.stop();
    },
  };
}
