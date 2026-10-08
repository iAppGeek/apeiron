import type { GridApi } from 'ag-grid-community';
import { installTestHooks, noteDelta, notePurge, noteRequest } from './hooks-gate';

/** A minimal consumer of the gate; hooks-gate.spec.ts bundles it to prove what survives tree-shaking. */
export function probe(api: GridApi): () => void {
  notePurge();
  noteRequest({ startRow: 0, endRow: 1, rowGroupCols: [], valueCols: [], groupKeys: [], sortModel: [] });
  noteDelta(undefined);
  return installTestHooks(api, () => 0);
}
