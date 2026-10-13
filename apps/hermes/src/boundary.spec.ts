import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = new URL('.', import.meta.url).pathname;
const sources = readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts') && f !== 'testing.ts');

describe('hermes boundaries', () => {
  it('has no database driver or database package: it is the venue, and the order service owns the data', () => {
    const pkg = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')) as { dependencies: Record<string, string> };
    const deps = Object.keys(pkg.dependencies);
    expect(deps).not.toContain('mongodb');
    expect(deps).not.toContain('@apeiron/mnemosyne');
    expect(deps.filter((d) => /mongo|mnemosyne|oracle|kdb|pg$/i.test(d))).toEqual([]);
  });

  it('does not import a database, decide order state with the shared rules, or touch the order stream', () => {
    for (const file of sources) {
      const text = readFileSync(join(here, file), 'utf8');
      expect(text, file).not.toMatch(/from '(mongodb|@apeiron\/mnemosyne)'/);
      expect(text, file).not.toMatch(/\b(applyExecReport|applyAmend|validateSubmission|MongoOrderRepository)\b/);
      expect(text, file).not.toMatch(/orders\.events|ordersEvents/);
    }
  });
});
