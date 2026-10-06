import v8 from 'node:v8';
import vm from 'node:vm';

export type MemorySnapshot = { heapMb: number; rssMb: number; arrayBuffersMb: number };

const mb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10;

/** Highest resident set size the process has reached so far, in MB. */
export function peakRssMb(): number {
  return mb(process.resourceUsage().maxRSS * 1024);
}

export function memorySnapshot(): MemorySnapshot {
  const m = process.memoryUsage();
  return { heapMb: mb(m.heapUsed), rssMb: mb(m.rss), arrayBuffersMb: mb(m.arrayBuffers) };
}

type Gc = () => void;
let gcFn: Gc | null | undefined;

/** Runs a full GC when the runtime allows it (enables the flag on demand), so heap figures show retained data. */
export function forceGc(): boolean {
  if (gcFn === undefined) {
    const existing = (globalThis as { gc?: Gc }).gc;
    if (existing !== undefined) {
      gcFn = existing;
    } else {
      try {
        v8.setFlagsFromString('--expose-gc');
        gcFn = vm.runInNewContext('gc') as Gc;
      } catch {
        gcFn = null;
      }
    }
  }
  if (gcFn === null || gcFn === undefined) return false;
  gcFn();
  return true;
}
