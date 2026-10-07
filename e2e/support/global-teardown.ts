import { startHermesContainer } from './driver';
import { createFaults } from './faults';

/** Runs even when a scenario crashed or timed out: no toxics left on the proxy, and the real hermes running again. */
export default async function globalTeardown(): Promise<void> {
  await createFaults().clear().catch(() => undefined);
  await startHermesContainer().catch(() => undefined);
}
