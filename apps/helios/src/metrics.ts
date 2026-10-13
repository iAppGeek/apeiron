import { Counter, Registry, collectDefaultMetrics } from 'prom-client';

/** The helios registry, served on the health port at `/metrics`. */
export class HeliosMetrics {
  readonly registry = new Registry();
  private readonly ticks: Counter;
  private readonly errors: Counter;

  constructor() {
    collectDefaultMetrics({ register: this.registry });
    this.ticks = new Counter({ name: 'helios_ticks_total', help: 'Price ticks published to prices.<PAIR>.', registers: [this.registry] });
    this.errors = new Counter({ name: 'helios_publish_errors_total', help: 'Ticks that failed to publish.', registers: [this.registry] });
  }

  tick(): void {
    this.ticks.inc();
  }

  publishError(): void {
    this.errors.inc();
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
