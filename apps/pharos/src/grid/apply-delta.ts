import type { GridApi } from 'ag-grid-community';
import type { ServerMsg } from '@apeiron/logos';

export type DeltaMsg = Extract<ServerMsg, { t: 'delta' }>;

/**
 * The place live updates land. The worker already forwards every `delta` as a `message` event, and the
 * blotter calls this with the grid api. Applying transactions, flashing cells and anchoring new rows
 * are phase 5, so for now a delta leaves the grid untouched.
 */
export function applyDelta(_api: GridApi, _delta: DeltaMsg): void {}
