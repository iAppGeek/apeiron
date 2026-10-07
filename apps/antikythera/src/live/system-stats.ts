import { LagMonitor, type LagSnapshot } from '../lag.js';

export type ServerStats = { cpu: number; rssMb: number; elLagMs: number };

/**
 * Process CPU, RSS and event-loop lag for the `summary` message. `sample()` is called once a second: CPU is the
 * busy share of that window in percent, lag is the window's p99. A second, cumulative lag histogram is kept for
 * measuring a whole run (`totalLag` / `resetTotalLag`).
 */
export class SystemStats {
  private readonly windowLag = new LagMonitor();
  private readonly cumulativeLag = new LagMonitor();
  private lastCpu = process.cpuUsage();
  private lastAt = performance.now();
  private current: ServerStats = { cpu: 0, rssMb: 0, elLagMs: 0 };
  private lastLag: LagSnapshot = { p50: 0, p99: 0, max: 0, samples: 0 };

  start(): void {
    this.windowLag.start();
    this.cumulativeLag.start();
  }

  stop(): void {
    this.windowLag.stop();
    this.cumulativeLag.stop();
  }

  /** Takes a fresh sample and starts a new window. */
  sample(): ServerStats {
    const now = performance.now();
    const cpu = process.cpuUsage();
    const busyMs = (cpu.user - this.lastCpu.user + (cpu.system - this.lastCpu.system)) / 1000;
    const elapsed = Math.max(1, now - this.lastAt);
    this.lastLag = this.windowLag.snapshot();
    this.current = {
      cpu: Math.round((busyMs / elapsed) * 1000) / 10,
      rssMb: Math.round(process.memoryUsage.rss() / 1048576),
      elLagMs: this.lastLag.p99,
    };
    this.lastCpu = cpu;
    this.lastAt = now;
    this.windowLag.reset();
    return this.current;
  }

  /** The most recent sample. */
  get latest(): ServerStats {
    return this.current;
  }

  /** The event-loop lag distribution of the last complete one-second window. */
  get lastWindowLag(): LagSnapshot {
    return this.lastLag;
  }

  totalLag(): LagSnapshot {
    return this.cumulativeLag.snapshot();
  }

  resetTotalLag(): void {
    this.cumulativeLag.reset();
  }
}
