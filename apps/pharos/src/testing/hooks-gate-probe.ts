import type { GridApi } from 'ag-grid-community';
import { installTestHooks, noteDelta, notePurge } from './hooks-gate';

/** A minimal consumer of the gate; hooks-gate.spec.ts bundles it to prove what survives tree-shaking. */
export function probe(api: GridApi): () => void {
  notePurge();
  noteDelta(undefined);
  return installTestHooks(api);
}
