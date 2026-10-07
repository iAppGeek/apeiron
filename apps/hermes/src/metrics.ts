import type { LoadPreset } from '@apeiron/logos';
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

export type HermesSnapshot = { preset: LoadPreset; live: number; pending: number; inflight: number };

const PRESETS: readonly LoadPreset[] = ['medium', 'stress'];

/**
 * The hermes registry, served on the health port at `/metrics`. Counters are updated as messages are
 * published, so `rate(hermes_price_ticks_total[...])` is ticks/s; the gauges are read at scrape time.
 */
export class HermesMetrics {
  readonly registry = new Registry();
  private readonly events: Counter;
  private readonly ticks: Counter;
  private readonly commands: Counter;
  private readonly errors: Counter;
  private snapshot: (() => HermesSnapshot | null) | null = null;

  constructor() {
    const registers = [this.registry];
    collectDefaultMetrics({ register: this.registry });
    this.events = new Counter({ name: 'hermes_events_published_total', help: 'Order events published to orders.events, by event type.', labelNames: ['type'], registers });
    this.ticks = new Counter({ name: 'hermes_price_ticks_total', help: 'Price ticks published to prices.<PAIR>.', registers });
    this.commands = new Counter({ name: 'hermes_commands_handled_total', help: 'Trader commands handled.', registers });
    this.errors = new Counter({ name: 'hermes_publish_errors_total', help: 'Messages that failed to publish.', registers });
    this.gauge('hermes_live_orders', 'Orders currently LIVE.', (g) => g.set(this.snapshot?.()?.live ?? 0));
    this.gauge('hermes_pending_orders', 'Orders waiting in PENDING_START.', (g) => g.set(this.snapshot?.()?.pending ?? 0));
    this.gauge('hermes_publish_inflight', 'Published messages not yet acknowledged by the broker.', (g) => g.set(this.snapshot?.()?.inflight ?? 0));
    this.gauge(
      'hermes_preset',
      'The active load preset: 1 for the preset in force, 0 for the others.',
      (g) => {
        const active = this.snapshot?.()?.preset;
        for (const preset of PRESETS) g.labels(preset).set(preset === active ? 1 : 0);
      },
      ['preset'],
    );
  }

  /** Connects the scrape-time gauges to the running simulator. */
  bind(snapshot: () => HermesSnapshot | null): void {
    this.snapshot = snapshot;
  }

  event(type: string): void {
    this.events.labels(type).inc();
  }

  tick(): void {
    this.ticks.inc();
  }

  commandHandled(): void {
    this.commands.inc();
  }

  publishError(): void {
    this.errors.inc();
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  private gauge(name: string, help: string, update: (gauge: Gauge) => void, labelNames: string[] = []): void {
    const gauge: Gauge = new Gauge({ name, help, labelNames, registers: [this.registry], collect: () => update(gauge) });
  }
}
