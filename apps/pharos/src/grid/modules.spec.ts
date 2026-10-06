import { ServerSideRowModelModule, SetFilterModule } from 'ag-grid-enterprise';
import { DateFilterModule, NumberFilterModule, TextFilterModule, TooltipModule } from 'ag-grid-community';
import { describe, expect, it } from 'vitest';
import { GRID_MODULES } from './modules';

describe('GRID_MODULES', () => {
  it('registers the server-side row model and the four filters', () => {
    for (const m of [ServerSideRowModelModule, SetFilterModule, TextFilterModule, NumberFilterModule, DateFilterModule, TooltipModule]) {
      expect(GRID_MODULES).toContain(m);
    }
  });

  it('has no duplicates', () => {
    expect(new Set(GRID_MODULES).size).toBe(GRID_MODULES.length);
  });
});
