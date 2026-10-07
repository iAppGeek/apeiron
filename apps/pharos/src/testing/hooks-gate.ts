import type { SsrmRequest } from '@apeiron/logos';
import type { GridApi } from 'ag-grid-community';
import type { ApplyStats } from '../grid/apply-delta';
import { installHooks, recordDelta, recordPurge, recordRequest } from './test-hooks';

/**
 * The only door (the check is repeated inline in each function, because a bundler only folds the literal comparison) to the test hooks. `import.meta.env.VITE_TEST_HOOKS` is replaced by Vite at build time, so a
 * normal build folds every branch below to nothing and tree-shakes `test-hooks.ts` out (hooks-gate.spec.ts builds
 * a probe both ways to prove it).
 */
/** Installs `window.__apeironTest` when this is a test-hooks build; returns the cleanup. */
export function installTestHooks(api: GridApi, pendingRequests: () => number): () => void {
  if (import.meta.env.VITE_TEST_HOOKS !== '1') return () => undefined;
  return installHooks(api, pendingRequests);
}

export function noteDelta(stats: ApplyStats | void): void {
  if (import.meta.env.VITE_TEST_HOOKS === '1') recordDelta(stats);
}

export function notePurge(): void {
  if (import.meta.env.VITE_TEST_HOOKS === '1') recordPurge();
}

export function noteRequest(request: SsrmRequest): void {
  if (import.meta.env.VITE_TEST_HOOKS === '1') recordRequest(request);
}
