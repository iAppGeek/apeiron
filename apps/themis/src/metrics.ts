import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

const COUNTS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];
const SECONDS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

/** Gauges read at scrape time. */
export type ThemisSnapshot = { openOrders: number };

/** The themis registry, served on the health port at `/metrics`. */
export class ThemisMetrics {
  readonly registry = new Registry();
  private readonly batchSize: Histogram;
  private readonly commitSeconds: Histogram;
  private readonly kvPutSeconds: Histogram;
  private readonly rebuildSeconds: Gauge;
  private readonly reports: Counter;
  private readonly clampedFills: Counter;
  private readonly submissions: Counter;
  private readonly commands: Counter;
  private readonly commandSeconds: Histogram;
  private snapshot: (() => ThemisSnapshot) | null = null;

  constructor() {
    const registers = [this.registry];
    collectDefaultMetrics({ register: this.registry });
    this.batchSize = new Histogram({ name: 'themis_commit_batch_size', help: 'Orders per group commit.', buckets: COUNTS, registers });
    this.commitSeconds = new Histogram({ name: 'themis_commit_duration_seconds', help: 'Time to store and publish one group commit.', buckets: SECONDS, registers });
    this.kvPutSeconds = new Histogram({ name: 'themis_kv_put_duration_seconds', help: 'Time to publish one group commit to ORDER_STATE.', buckets: SECONDS, registers });
    this.reports = new Counter({
      name: 'themis_exec_reports_total',
      help: 'Execution reports handled, by type and result (applied, duplicate, rejected, unknown, invalid).',
      labelNames: ['type', 'result'],
      registers,
    });
    this.clampedFills = new Counter({ name: 'themis_fills_clamped_total', help: 'Fills larger than the remaining quantity, cut back to it.', registers });
    this.submissions = new Counter({
      name: 'themis_submissions_total',
      help: 'orders.submit requests, by result (accepted, duplicate, invalid).',
      labelNames: ['result'],
      registers,
    });
    this.commands = new Counter({
      name: 'themis_commands_total',
      help: 'Commands handled, by kind (action, amend) and result (ok or the reject code).',
      labelNames: ['kind', 'result'],
      registers,
    });
    this.commandSeconds = new Histogram({ name: 'themis_command_duration_seconds', help: 'Time from a command to its reply.', buckets: SECONDS, registers });
    this.rebuildSeconds = new Gauge({ name: 'themis_projection_rebuild_seconds', help: 'Duration of the last projection rebuild (0 if none ran).', registers });
    const snapshotOf = (): ThemisSnapshot => this.snapshot?.() ?? { openOrders: 0 };
    new Gauge({
      name: 'themis_open_orders',
      help: 'Orders that can still change and are held in memory.',
      registers,
      collect(): void {
        this.set(snapshotOf().openOrders);
      },
    });
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  bind(snapshot: () => ThemisSnapshot): void {
    this.snapshot = snapshot;
  }

  commit(info: { batchSize: number; seconds: number }): void {
    this.batchSize.observe(info.batchSize);
    this.commitSeconds.observe(info.seconds);
  }

  kvPut(seconds: number): void {
    this.kvPutSeconds.observe(seconds);
  }

  report(type: string, result: 'applied' | 'duplicate' | 'rejected' | 'unknown' | 'invalid'): void {
    this.reports.inc({ type, result });
  }

  command(kind: string, result: string, seconds: number): void {
    this.commands.inc({ kind, result });
    if (result === 'ok') this.commandSeconds.observe(seconds);
  }

  clamped(): void {
    this.clampedFills.inc();
  }

  submission(result: 'accepted' | 'duplicate' | 'invalid'): void {
    this.submissions.inc({ result });
  }

  projectionRebuilt(seconds: number): void {
    this.rebuildSeconds.set(seconds);
  }
}
